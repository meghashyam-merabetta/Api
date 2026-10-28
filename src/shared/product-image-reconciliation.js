import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { sequelize } from '../config/database.js';
import { models } from '../models/index.js';
import { s3 } from './image_upload.js';
import {
  IMAGE_BUCKET,
  managedProductImageKey,
  objectExists,
  isImageReferenced,
  queueImageCleanup,
  processImageCleanup,
} from './image-storage.js';
import { publishProductCatalog } from './catalog-publisher.js';

// Default is read-only. Only definitive 404s are missing; permission/network errors abort.
export async function reconcileProductImages({
  apply = false,
  minimumAgeMs = 86400000,
} = {}) {
  const report = { missing: [], orphans: [], removedRows: 0, queuedObjects: 0 };
  const images = await models.productImage.findAll();
  for (const snapshot of images) {
    if (await objectExists(snapshot.s3_key)) continue;
    report.missing.push({
      id: snapshot.id,
      product_id: snapshot.product_id,
      s3_key: snapshot.s3_key,
    });
    if (!apply) continue;
    await sequelize.transaction(async (transaction) => {
      const parent = await models.product.findByPk(snapshot.product_id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!parent) return;
      const row = await models.productImage.findByPk(snapshot.id, { transaction });
      if (!row || row.s3_key !== snapshot.s3_key || (await objectExists(row.s3_key)))
        return;
      await row.destroy({ transaction });
      if (row.is_primary) {
        const next = await models.productImage.findOne({
          where: { product_id: parent.product_id },
          order: [
            ['sort_order', 'ASC'],
            ['id', 'ASC'],
          ],
          transaction,
        });
        if (next) await next.update({ is_primary: true }, { transaction });
      }
      await publishProductCatalog(parent.product_id, transaction);
      report.removedRows++;
    });
  }
  let continuation;
  const seen = new Set();
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: IMAGE_BUCKET,
        Prefix: 'upload/',
        ContinuationToken: continuation,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (
        !managedProductImageKey(object.Key) ||
        !object.LastModified ||
        Date.now() - new Date(object.LastModified).getTime() < minimumAgeMs
      )
        continue;
      if (await isImageReferenced(object.Key)) continue;
      report.orphans.push(object.Key);
      if (apply) {
        await queueImageCleanup(object.Key);
        report.queuedObjects++;
      }
    }
    continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!continuation || seen.has(continuation)))
      throw new Error('S3 listing returned an invalid continuation token');
    if (continuation) seen.add(continuation);
  } while (continuation);
  if (apply) await processImageCleanup();
  return report;
}
