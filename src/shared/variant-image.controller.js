import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { models } from '../models/index.js';
import { HttpError } from './errors.js';
import { createImageUpload } from './image_upload.js';
import { MAX_PRODUCT_IMAGES } from './product-images.js';
import { catalogTransaction } from './catalog-audit.js';
import { catalogMutation, fingerprint, sendMutation } from './catalog-idempotency.js';
import {
  reserveImage,
  stageImage,
  imageUrl,
  queueImageCleanup,
  finishImageCleanup,
} from './image-storage.js';
import { publishProductCatalog } from './catalog-publisher.js';
import { galleryOrder, variantGallery, defaultGallery } from './variant-galleries.js';

async function owner(productId, variantId, transaction) {
  // The same parent lock used by product/variant writes serializes sharing and edits.
  const product = await models.product.findByPk(productId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!product) throw new HttpError(404, 'Product not found');
  const variant = await models.productVariant.findOne({
    where: { id: variantId, product_id: productId },
    transaction,
  });
  if (!variant) throw new HttpError(404, 'Product variant not found');
  return { product, variant };
}
async function selected(variantId, imageId, transaction) {
  const row = await models.variantImage.findOne({
    where: { id: imageId, variant_id: variantId },
    transaction,
  });
  if (!row) throw new HttpError(404, 'Variant image not found in this custom gallery');
  return row;
}
async function promote(variantId, transaction) {
  const rows = await models.variantImage.findAll({
    where: { variant_id: variantId },
    order: galleryOrder,
    transaction,
  });
  if (rows.length && !rows.some((row) => row.is_primary))
    await rows[0].update({ is_primary: true }, { transaction });
}
export async function getVariantImages(req, res) {
  const data = await catalogTransaction(req, async (transaction) => {
    const { product, variant } = await owner(
      req.validatedParams.productId,
      req.validatedParams.variantId,
      transaction,
    );
    return variantGallery(variant, product, transaction);
  });
  res.json({ data });
}
export async function setVariantImageMode(req, res) {
  const data = await catalogTransaction(req, async (transaction) => {
    const { product, variant } = await owner(
      req.validatedParams.productId,
      req.validatedParams.variantId,
      transaction,
    );
    await variant.update(req.validated, { transaction });
    await publishProductCatalog(product.product_id, transaction);
    return variantGallery(variant, product, transaction);
  });
  res.json({ data });
}
const multipart = createImageUpload();
export function uploadVariantImage(req, res, next) {
  multipart(req, res, async (error) => {
    if (error) return next(error);
    let removedKey;
    try {
      const { productId, variantId, imageId } = req.validatedParams;
      const file = req.files[0];
      const reserved = await reserveImage('products', productId, file);
      const result = await catalogMutation(
        req,
        { type: file.mimetype, hash: fingerprint(file.buffer.toString('base64')) },
        imageId ? 200 : 201,
        async (transaction) => {
          const { product, variant } = await owner(productId, variantId, transaction);
          const current = imageId
            ? await selected(variantId, imageId, transaction)
            : null;
          const rows = await models.variantImage.findAll({
            where: { variant_id: variantId },
            transaction,
          });
          if (!current && rows.length >= MAX_PRODUCT_IMAGES)
            throw new HttpError(
              400,
              `A variant can have a maximum of ${MAX_PRODUCT_IMAGES} images`,
            );
          const { key, journal } = await stageImage(reserved, file, transaction);
          if (current) {
            removedKey = current.s3_key;
            await queueImageCleanup(removedKey, transaction);
            await current.update(
              { s3_key: key, image_url: imageUrl(key) },
              { transaction },
            );
          } else {
            await models.variantImage.create(
              {
                variant_id: variantId,
                s3_key: key,
                image_url: imageUrl(key),
                sort_order: Math.max(-1, ...rows.map((row) => row.sort_order)) + 1,
                is_primary: !rows.some((row) => row.is_primary),
              },
              { transaction },
            );
          }
          await variant.update({ use_product_images: false }, { transaction });
          await journal.destroy({ transaction });
          await publishProductCatalog(product.product_id, transaction);
          return variantGallery(variant, product, transaction);
        },
      );
      await finishImageCleanup([removedKey]);
      sendMutation(res, result);
    } catch (uploadError) {
      next(uploadError);
    }
  });
}
export async function deleteVariantImage(req, res) {
  let removedKey;
  await catalogTransaction(req, async (transaction) => {
    const { productId, variantId, imageId } = req.validatedParams;
    const { variant } = await owner(productId, variantId, transaction);
    const row = await selected(variantId, imageId, transaction);
    removedKey = row.s3_key;
    await queueImageCleanup(removedKey, transaction);
    await row.destroy({ transaction });
    await promote(variantId, transaction);
    await variant.update({ use_product_images: false }, { transaction });
    await publishProductCatalog(productId, transaction);
  });
  await finishImageCleanup([removedKey]);
  res.status(204).end();
}
export async function primaryVariantImage(req, res) {
  const data = await catalogTransaction(req, async (transaction) => {
    const { productId, variantId, imageId } = req.validatedParams;
    const { product, variant } = await owner(productId, variantId, transaction);
    const row = await selected(variantId, imageId, transaction);
    await models.variantImage.update(
      { is_primary: false },
      { where: { variant_id: variantId, is_primary: true }, transaction },
    );
    await row.update({ is_primary: true }, { transaction });
    await variant.update({ use_product_images: false }, { transaction });
    await publishProductCatalog(productId, transaction);
    return variantGallery(variant, product, transaction);
  });
  res.json({ data });
}
export async function shareVariantImages(req, res) {
  const removedKeys = [];
  const result = await catalogMutation(req, req.validated, 200, async (transaction) => {
    const { productId } = req.validatedParams;
    const { product, variant } = await owner(
      productId,
      req.validated.source_variant_id,
      transaction,
    );
    const source = await variantGallery(variant, product, transaction);
    const desired = source.effective_images;
    const old = await defaultGallery(product, transaction);
    // Existing independent products may refer to legacy product rows. Never silently
    // change their images; sharing cannot remove those protected source records.
    const [table] = await sequelize.query(
      "SELECT to_regclass('public.independent_product_images') AS name",
      { type: QueryTypes.SELECT, transaction },
    );
    for (const row of old) {
      if (desired.some((image) => image.s3_key === row.s3_key)) continue;
      if (!row.inherited && table.name) {
        const refs = await sequelize.query(
          'SELECT 1 FROM independent_product_images WHERE source_image_id=:id LIMIT 1',
          { replacements: { id: row.id }, type: QueryTypes.SELECT, transaction },
        );
        if (refs.length)
          throw new HttpError(
            409,
            'Product gallery is referenced by independent products; sharing would change their gallery',
          );
      }
      if (row.inherited) {
        await sequelize.query(
          'DELETE FROM independent_product_images WHERE product_id=:product AND source_image_id=:image',
          { replacements: { product: productId, image: row.id }, transaction },
        );
      } else {
        await models.productImage.destroy({
          where: { id: row.id, product_id: productId },
          transaction,
        });
      }
      removedKeys.push(row.s3_key);
      await queueImageCleanup(row.s3_key, transaction);
    }
    // Demote first to satisfy the one-primary partial unique index.
    await models.productImage.update(
      { is_primary: false },
      { where: { product_id: productId, is_primary: true }, transaction },
    );
    if (product.inventory_managed)
      await sequelize.query(
        'UPDATE independent_product_images SET is_primary=FALSE WHERE product_id=:id',
        { replacements: { id: productId }, transaction },
      );
    for (const [index, row] of desired.entries()) {
      const values = {
        is_primary: index === 0,
        sort_order: index,
        alt_text: row.alt_text,
      };
      const prior = old.find((image) => image.s3_key === row.s3_key);
      if (prior?.inherited) {
        await sequelize.query(
          'UPDATE independent_product_images SET is_primary=:primary,sort_order=:sort WHERE product_id=:product AND source_image_id=:image',
          {
            replacements: {
              primary: index === 0,
              sort: index,
              product: productId,
              image: prior.id,
            },
            transaction,
          },
        );
      } else if (prior) {
        await models.productImage.update(values, {
          where: { id: prior.id },
          transaction,
        });
      } else {
        await models.productImage.create(
          {
            ...values,
            product_id: productId,
            image_url: row.image_url,
            s3_key: row.s3_key,
          },
          { transaction },
        );
      }
    }
    await models.productVariant.update(
      { use_product_images: true },
      { where: { product_id: productId }, transaction },
    );
    await variant.reload({ transaction });
    await publishProductCatalog(productId, transaction);
    return {
      ...(await variantGallery(variant, product, transaction)),
      shared_to_all_variants: true,
    };
  });
  await finishImageCleanup(removedKeys);
  sendMutation(res, result);
}
