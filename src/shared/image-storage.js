import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import {
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { sequelize } from '../config/database.js';
import { ProductImageCleanup } from '../models/catalog-reliability.model.js';
import { models } from '../models/index.js';
import { logger } from '../config/logger.js';
import { HttpError } from './errors.js';
import { s3 } from './image_upload.js';

export const IMAGE_BUCKET = 'prod-merabetta';
const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const imageUrl = (key) =>
  `https://${IMAGE_BUCKET}.s3.ap-south-1.amazonaws.com/${key}`;
export const managedImageKey = (key) =>
  /^upload\/(?:[0-9]+[a-j]\.(?:jpg|png|webp)|(?:products|categories|brands)\/[0-9]+\/[0-9a-f-]{36}\.(?:jpg|png|webp))$/.test(
    key,
  );

export const managedProductImageKey = (key) =>
  managedImageKey(key) &&
  (key.startsWith('upload/products/') || /^upload\/[0-9]+[a-j]\./.test(key));

export function managedImageKeyFromUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== new URL(imageUrl('')).origin) return null;
    const key = decodeURIComponent(url.pathname.slice(1));
    return managedImageKey(key) ? key : null;
  } catch {
    return null;
  }
}

export async function queueImageUrlCleanup(value, transaction) {
  const key = managedImageKeyFromUrl(value);
  if (key) await queueImageCleanup(key, transaction);
}

export async function isImageReferenced(key, transaction) {
  if (await models.productImage.count({ where: { s3_key: key }, transaction }))
    return true;
  const url = imageUrl(key);
  for (const [model, field] of [
    [models.category, 'category_image'],
    [models.brand, 'image_url'],
  ]) {
    if (
      await model.count({
        where: {
          [Op.or]: [
            { [field]: url },
            { [field]: { [Op.like]: `${url}?%` } },
            { [field]: { [Op.like]: `${url}#%` } },
          ],
        },
        transaction,
      })
    )
      return true;
  }
  return false;
}

export async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: IMAGE_BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (
      error?.$metadata?.httpStatusCode === 404 ||
      ['NotFound', 'NoSuchKey'].includes(error?.name)
    )
      return false;
    throw error;
  }
}

export async function queueImageCleanup(key, transaction) {
  await ProductImageCleanup.findOrCreate({ where: { s3_key: key }, transaction });
}

// A committed journal exists before S3 is touched. A crash/rollback leaves retryable cleanup.
// New keys are immutable: replacement never overwrites the currently referenced object.
export async function reserveImage(resource, resourceId, file) {
  if (
    !['products', 'categories', 'brands'].includes(resource) ||
    !/^[1-9][0-9]*$/.test(String(resourceId))
  ) {
    throw new HttpError(400, 'Invalid image resource');
  }
  const key = `upload/${resource}/${resourceId}/${randomUUID()}.${extension[file.mimetype]}`;
  await ProductImageCleanup.create({
    s3_key: key,
    not_before: new Date(Date.now() + 3600000),
  });
  return key;
}

export async function stageImage(key, file, transaction) {
  const journal = await ProductImageCleanup.findByPk(key, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!journal) throw new HttpError(409, 'Image staging expired; retry the request');
  await s3.send(
    new PutObjectCommand({
      Bucket: IMAGE_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'no-cache',
      IfNoneMatch: '*',
    }),
  );
  return { key, journal };
}

export async function processImageCleanup({ limit = 20 } = {}) {
  let processed = 0;
  for (let index = 0; index < limit; index++) {
    const found = await sequelize.transaction(async (transaction) => {
      const job = await ProductImageCleanup.findOne({
        where: { not_before: { [Op.lte]: new Date() } },
        order: [['not_before', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!job) return false;
      try {
        // Protect referenced objects, including after an ambiguous commit outcome.
        if (!(await isImageReferenced(job.s3_key, transaction)))
          await s3.send(
            new DeleteObjectCommand({ Bucket: IMAGE_BUCKET, Key: job.s3_key }),
          );
        await job.destroy({ transaction });
        processed++;
      } catch (error) {
        // Transport/storage errors are retried indefinitely with capped backoff.
        await job.update(
          {
            attempts: job.attempts + 1,
            last_error: String(error.message).slice(0, 1000),
            not_before: new Date(
              Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)),
            ),
          },
          { transaction },
        );
        logger.warn({ key: job.s3_key, error: error.message }, 'Image cleanup deferred');
      }
      return true;
    });
    if (!found) break;
  }
  return processed;
}

export function startImageCleanupWorker() {
  let running;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = processImageCleanup()
      .catch((error) => logger.error({ err: error }, 'Image cleanup failed'))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 30000).unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
