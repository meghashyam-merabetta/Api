import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import { createImageUpload, MAX_IMAGE_BATCH_BYTES } from '../../shared/image_upload.js';
import { batchBannerMetadataSchema } from './banners.schema.js';
import {
  finishImageCleanup,
  imageUrl,
  managedImageKeyFromUrl,
  queueImageUrlCleanup,
  reserveImage,
  stageImage,
} from '../../shared/image-storage.js';

const columns = `banner_key, page_name, banner_name, image_path, width_px, height_px,
  is_active, banner_id, banner_type, banner_description, cta_text, link_url,
  mobile_image_path, status, display_order, is_published, publish_start_at,
  publish_end_at, published_at, created_at, updated_at`;

async function findBanner(key, transaction, lock = false) {
  const rows = await sequelize.query(
    `SELECT ${columns} FROM page_banners WHERE banner_key = :key${lock ? ' FOR UPDATE' : ''}`,
    { replacements: { key }, type: QueryTypes.SELECT, transaction },
  );
  if (!rows[0]) throw new HttpError(404, 'Banner not found');
  return rows[0];
}

function buildUpdate(values) {
  const keys = Object.keys(values);
  return {
    sql: keys.map((key, index) => `"${key}" = :value${index}`).join(', '),
    replacements: Object.fromEntries(
      keys.map((key, index) => [`value${index}`, values[key]]),
    ),
  };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function nextBannerKey(baseKey, existingKeys) {
  if (!existingKeys.includes(baseKey)) return baseKey;
  const suffixPattern = new RegExp(`^${escapeRegExp(baseKey)}-(\\d+)$`);
  const highest = existingKeys.reduce((maximum, key) => {
    const match = suffixPattern.exec(key);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 1);
  const next = `${baseKey}-${String(highest + 1).padStart(2, '0')}`;
  if (next.length > 100)
    throw new HttpError(422, 'Banner placement key is too long to add another banner');
  return next;
}

async function allocateBannerKey(baseKey, transaction) {
  // Serialize allocation per placement so concurrent admins cannot receive the same suffix.
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:baseKey, 0))', {
    replacements: { baseKey },
    type: QueryTypes.SELECT,
    transaction,
  });
  const prefix = `${baseKey}-`;
  const rows = await sequelize.query(
    `SELECT banner_key FROM page_banners
     WHERE banner_key = :baseKey OR left(banner_key, length(:prefix)) = :prefix`,
    {
      replacements: { baseKey, prefix },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return nextBannerKey(
    baseKey,
    rows.map((row) => row.banner_key),
  );
}

export async function listBanners(req, res) {
  const { limit, offset, sort_by, sort_order, ...filters } = req.validatedQuery;
  const where = [];
  const replacements = { limit, offset };
  for (const field of ['status', 'page_name']) {
    if (filters[field] !== undefined) {
      where.push(`${field} = :${field}`);
      replacements[field] = filters[field];
    }
  }
  for (const field of ['is_published', 'is_active']) {
    if (filters[field] !== undefined) {
      where.push(`${field} = :${field}`);
      replacements[field] = filters[field] === 'true';
    }
  }
  if (filters.search) {
    where.push('(banner_name ILIKE :search OR banner_key ILIKE :search)');
    replacements.search = `%${filters.search}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [data, count] = await Promise.all([
    sequelize.query(
      `SELECT ${columns} FROM page_banners ${clause}
       ORDER BY "${sort_by}" ${sort_order.toUpperCase()}, banner_id ASC LIMIT :limit OFFSET :offset`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query(`SELECT count(*)::integer AS total FROM page_banners ${clause}`, {
      replacements,
      type: QueryTypes.SELECT,
    }),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    data,
    pagination: {
      total: count[0].total,
      limit,
      offset,
      hasMore: offset + data.length < count[0].total,
    },
  });
}

export async function getBanner(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ data: await findBanner(req.validatedParams.bannerKey) });
}

export async function createBanner(req, res) {
  try {
    const row = await sequelize.transaction(async (transaction) => {
      const values = {
        ...req.validated,
        banner_key: await allocateBannerKey(req.validated.banner_key, transaction),
      };
      const keys = Object.keys(values);
      const replacements = Object.fromEntries(
        keys.map((key, index) => [`value${index}`, values[key]]),
      );
      const result = await sequelize.query(
        `INSERT INTO page_banners (banner_id, ${keys.map((key) => `"${key}"`).join(', ')})
         VALUES (nextval('page_banners_banner_id_seq'), ${keys.map((_key, index) => `:value${index}`).join(', ')})
         RETURNING ${columns}`,
        { replacements, type: QueryTypes.INSERT, transaction },
      );
      return result[0][0];
    });
    res.status(201).json({ data: row });
  } catch (error) {
    if (error?.original?.code === '23505')
      throw new HttpError(409, 'Banner key already exists');
    throw error;
  }
}

const batchMultipart = createImageUpload({
  maxFiles: 10,
  maxTotalBytes: MAX_IMAGE_BATCH_BYTES,
  maxFields: 1,
});
const parseBatchImages = (req, res) =>
  new Promise((resolve, reject) =>
    batchMultipart(req, res, (error) => (error ? reject(error) : resolve())),
  );

export async function createBannerBatch(req, res) {
  await parseBatchImages(req, res);
  let metadata;
  try {
    metadata = batchBannerMetadataSchema.parse(JSON.parse(req.body.metadata ?? ''));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new HttpError(422, 'metadata must be valid JSON');
    throw error;
  }
  const files = req.files ?? [];
  if (metadata.images.length !== files.length)
    throw new HttpError(
      422,
      'metadata.images must contain one dimensions entry per image',
    );

  // Reserve IDs and durable cleanup journals before the row transaction. If any later
  // operation fails, the cleanup worker safely removes every unreferenced staged object.
  const reserved = [];
  for (const file of files) {
    const ids = await sequelize.query(
      `SELECT nextval('page_banners_banner_id_seq')::bigint AS banner_id`,
      { type: QueryTypes.SELECT },
    );
    const bannerId = ids[0].banner_id;
    reserved.push({
      bannerId,
      file,
      key: await reserveImage('banners', bannerId, file),
    });
  }

  const rows = await sequelize.transaction(async (transaction) => {
    const created = [];
    for (let index = 0; index < reserved.length; index++) {
      const item = reserved[index];
      const bannerKey = await allocateBannerKey(metadata.banner_key, transaction);
      const staged = await stageImage(item.key, item.file, transaction);
      const dimensions = metadata.images[index];
      const result = await sequelize.query(
        `INSERT INTO page_banners (
           banner_id, banner_key, page_name, banner_name, image_path,
           width_px, height_px, is_active, banner_type, status
         ) VALUES (
           :bannerId, :bannerKey, :pageName, :bannerName, :imagePath,
           :width, :height, :active, 'WEBSITE', :status
         ) RETURNING ${columns}`,
        {
          replacements: {
            bannerId: item.bannerId,
            bannerKey,
            pageName: metadata.page_name,
            bannerName: metadata.banner_name,
            imagePath: imageUrl(staged.key),
            width: dimensions.width_px,
            height: dimensions.height_px,
            active: metadata.is_active,
            status: metadata.is_active ? 'ACTIVE' : 'INACTIVE',
          },
          type: QueryTypes.INSERT,
          transaction,
        },
      );
      await staged.journal.destroy({ transaction });
      created.push(result[0][0]);
    }
    return created;
  });
  res.status(201).json({ data: rows });
}

export async function updateBanner(req, res) {
  const key = req.validatedParams.bannerKey;
  const row = await sequelize.transaction(async (transaction) => {
    const current = await findBanner(key, transaction, true);
    const start = req.validated.publish_start_at ?? current.publish_start_at;
    const end = req.validated.publish_end_at ?? current.publish_end_at;
    if (start && end && new Date(end) <= new Date(start))
      throw new HttpError(422, 'publish_end_at must be after publish_start_at');
    for (const field of ['image_path', 'mobile_image_path']) {
      if (Object.hasOwn(req.validated, field) && req.validated[field] !== current[field])
        await queueImageUrlCleanup(current[field], transaction);
    }
    const values = { ...req.validated };
    if (values.is_published === true && !current.is_published)
      values.published_at = new Date();
    if (values.is_published === false) values.published_at = null;
    const update = buildUpdate(values);
    const result = await sequelize.query(
      `UPDATE page_banners SET ${update.sql}, updated_at = now()
       WHERE banner_key = :key RETURNING ${columns}`,
      {
        replacements: { ...update.replacements, key },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );
    return result[0][0];
  });
  res.json({ data: row });
}

export async function deleteBanner(req, res) {
  const removed = await sequelize.transaction(async (transaction) => {
    const current = await findBanner(req.validatedParams.bannerKey, transaction, true);
    await queueImageUrlCleanup(current.image_path, transaction);
    await queueImageUrlCleanup(current.mobile_image_path, transaction);
    await sequelize.query('DELETE FROM page_banners WHERE banner_key = :key', {
      replacements: { key: current.banner_key },
      type: QueryTypes.DELETE,
      transaction,
    });
    return [
      managedImageKeyFromUrl(current.image_path),
      managedImageKeyFromUrl(current.mobile_image_path),
    ];
  });
  await finishImageCleanup(removed);
  res.status(204).end();
}

const multipart = createImageUpload();
const parseImage = (req, res) =>
  new Promise((resolve, reject) =>
    multipart(req, res, (error) => (error ? reject(error) : resolve())),
  );

function imageController(field) {
  return async (req, res) => {
    await parseImage(req, res);
    const key = req.validatedParams.bannerKey;
    const existing = await findBanner(key);
    const file = req.files[0];
    const reserved = await reserveImage('banners', existing.banner_id, file);
    let removed;
    const row = await sequelize.transaction(async (transaction) => {
      const current = await findBanner(key, transaction, true);
      const staged = await stageImage(reserved, file, transaction);
      await queueImageUrlCleanup(current[field], transaction);
      removed = managedImageKeyFromUrl(current[field]);
      const result = await sequelize.query(
        `UPDATE page_banners SET "${field}" = :url, updated_at = now()
         WHERE banner_key = :key RETURNING ${columns}`,
        {
          replacements: { url: imageUrl(staged.key), key },
          type: QueryTypes.UPDATE,
          transaction,
        },
      );
      await staged.journal.destroy({ transaction });
      return result[0][0];
    });
    await finishImageCleanup([removed]);
    res.json({ data: row });
  };
}

export const uploadBannerImage = imageController('image_path');
export const uploadBannerMobileImage = imageController('mobile_image_path');

export async function deleteBannerMobileImage(req, res) {
  const removed = await sequelize.transaction(async (transaction) => {
    const current = await findBanner(req.validatedParams.bannerKey, transaction, true);
    await queueImageUrlCleanup(current.mobile_image_path, transaction);
    await sequelize.query(
      'UPDATE page_banners SET mobile_image_path = NULL, updated_at = now() WHERE banner_key = :key',
      { replacements: { key: current.banner_key }, type: QueryTypes.UPDATE, transaction },
    );
    return managedImageKeyFromUrl(current.mobile_image_path);
  });
  await finishImageCleanup([removed]);
  res.status(204).end();
}
