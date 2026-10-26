import { publishProductCatalog, deactivateProductCatalog } from './catalog-publisher.js';
import { randomUUID } from 'node:crypto';
import { normalizePricing, storedCatalogFields } from './catalog-fields.js';
import { Op } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { productImageUpload, s3 } from './product_image.js';
import {
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const Product = models.product;
const Category = models.category;
const ProductCategory = models.productCategory;

const S3_BUCKET = 'prod-merabetta';
const S3_REGION = 'ap-south-1';
const IMAGE_SLOTS = ['a', 'b', 'c', 'd', 'e', 'f'];
const MAX_PRODUCT_IMAGES = 6;

function getProductImageKey(productId, slot, mimetype = 'image/jpeg') {
  const normalizedSlot = String(slot).toLowerCase();

  if (!IMAGE_SLOTS.includes(normalizedSlot)) {
    throw new HttpError(400, 'Invalid image slot');
  }

  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[
    mimetype
  ];
  return `upload/${productId}${normalizedSlot}.${extension}`;
}

function getProductImageUrl(s3Key) {
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${s3Key}`;
}

function getSlotFromKey(productId, s3Key) {
  const escapedProductId = String(productId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const match = String(s3Key).match(
    new RegExp(`^upload/${escapedProductId}([a-f])\\.(?:jpg|png|webp)$`),
  );

  return match ? match[1] : null;
}

async function s3ObjectExists(key) {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }),
    );

    return true;
  } catch (error) {
    if (
      error?.$metadata?.httpStatusCode === 404 ||
      error?.name === 'NotFound' ||
      error?.name === 'NoSuchKey'
    ) {
      return false;
    }

    throw error;
  }
}

async function findProduct(productId, transaction) {
  const product = await Product.findByPk(productId, {
    transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });

  if (!product) {
    throw new HttpError(404, 'Product not found');
  }

  return product;
}

async function validateBrand(brandId, transaction) {
  if (brandId === null || brandId === undefined) return;
  const brand = await models.brand.findByPk(brandId, {
    transaction,
    lock: transaction.LOCK.SHARE,
  });
  if (!brand) throw new HttpError(400, 'Brand not found');
}

function catalogIncludes() {
  return [
    { model: models.brand, as: 'brand' },
    {
      model: models.productVariant,
      as: 'variants',
      separate: true,
      order: [
        ['sku', 'ASC'],
        ['id', 'ASC'],
      ],
    },
    {
      model: models.productImage,
      as: 'images',
      separate: true,
      order: [
        ['is_primary', 'DESC'],
        ['sort_order', 'ASC'],
        ['id', 'ASC'],
      ],
    },
  ];
}

async function validateCategories(categoryIds, transaction) {
  const ids = [...new Set(categoryIds.map(String))];

  if (ids.length === 0) {
    return;
  }

  const categories = await Category.findAll({
    where: {
      category_id: { [Op.in]: ids },
    },
    attributes: ['category_id'],
    transaction,
  });

  if (categories.length !== ids.length) {
    throw new HttpError(400, 'One or more categories were not found');
  }
}

async function replaceProductCategories(
  productId,
  categoryIds,
  primaryCategoryId,
  transaction,
) {
  const uniqueIds = [...new Set(categoryIds.map(String))];

  await validateCategories(uniqueIds, transaction);

  if (
    primaryCategoryId !== null &&
    primaryCategoryId !== undefined &&
    !uniqueIds.includes(String(primaryCategoryId))
  ) {
    throw new HttpError(400, 'The primary category must be included in category_ids');
  }

  await ProductCategory.destroy({
    where: { product_id: productId },
    transaction,
  });

  if (uniqueIds.length > 0) {
    await ProductCategory.bulkCreate(
      uniqueIds.map((categoryId) => ({
        product_id: productId,
        category_id: categoryId,
        is_primary:
          primaryCategoryId !== null &&
          primaryCategoryId !== undefined &&
          String(categoryId) === String(primaryCategoryId),
      })),
      { transaction },
    );
  }
}

// ======================================================
// PRODUCT CRUD
// ======================================================

export async function listProducts(req, res) {
  const {
    limit = 20,
    offset = 0,
    category_id,
    search,
    product_status,
    brand_id,
    sort_by = 'product_id',
    sort_order = 'asc',
  } = req.validatedQuery;

  const where = {};

  if (search) {
    where[Op.or] = [
      { product_name: { [Op.iLike]: `%${search}%` } },
      { product_code: { [Op.iLike]: `%${search}%` } },
      { sku: { [Op.iLike]: `%${search}%` } },
      { keywords: { [Op.contains]: [search] } },
    ];
  }

  if (product_status) {
    where.product_status = product_status;
  }

  if (brand_id !== undefined) where.brand_id = brand_id;

  const include = [
    ...catalogIncludes(),
    {
      model: Category,
      as: 'categories',
      through: { attributes: ['is_primary'] },
      required: category_id !== undefined,
      ...(category_id !== undefined ? { where: { category_id } } : {}),
    },
  ];

  const { rows, count } = await Product.findAndCountAll({
    where,
    include,
    distinct: true,
    limit,
    offset,
    order: [
      [sort_by, sort_order.toUpperCase()],
      ...(sort_by === 'product_id' ? [] : [['product_id', 'ASC']]),
    ],
  });

  res.json({
    data: rows,
    pagination: {
      total: count,
      limit,
      offset,
      hasMore: offset + rows.length < count,
    },
  });
}

export async function getProduct(req, res) {
  const product = await findProduct(req.validatedParams.productId);

  const result = await Product.findByPk(product.product_id, {
    include: [
      {
        model: Category,
        as: 'categories',
        through: { attributes: ['is_primary'] },
      },
      ...catalogIncludes(),
    ],
  });

  res.json({ data: result });
}

export async function createProduct(req, res) {
  const data = normalizePricing(req.validated);

  const product = await sequelize.transaction(async (transaction) => {
    const categoryIds = data.category_ids ?? [];
    const primaryCategoryId = data.primary_category_id ?? null;

    await validateCategories(categoryIds, transaction);
    await validateBrand(data.brand_id, transaction);

    const created = await Product.create(
      {
        ...Object.fromEntries(
          storedCatalogFields
            .filter((field) => Object.hasOwn(data, field))
            .map((field) => [field, data[field]]),
        ),
        product_name: data.product_name,
        slug: data.slug,
        brand_id: data.brand_id ?? null,
        short_description: data.short_description ?? null,
        description: data.description ?? null,
        product_status: data.product_status ?? 'draft',
      },
      { transaction },
    );

    if (categoryIds.length > 0) {
      await replaceProductCategories(
        created.product_id,
        categoryIds,
        primaryCategoryId,
        transaction,
      );
    }

    await publishProductCatalog(created.product_id, transaction);
    return created;
  });

  res.status(201).json({ data: product });
}

export async function updateProduct(req, res) {
  const product = await sequelize.transaction(async (transaction) => {
    const existing = await findProduct(req.validatedParams.productId, transaction);

    const data = normalizePricing(req.validated, existing.toJSON());
    if (Object.hasOwn(data, 'brand_id')) await validateBrand(data.brand_id, transaction);
    if (
      data.product_type === 'simple' &&
      (await models.productVariant.count({
        where: { product_id: existing.product_id },
        transaction,
      }))
    )
      throw new HttpError(409, 'Remove variants before changing to a simple product');

    const fields = [
      ...storedCatalogFields,
      'product_name',
      'slug',
      'brand_id',
      'short_description',
      'description',
      'product_status',
    ];

    for (const field of fields) {
      if (Object.hasOwn(data, field)) {
        existing[field] = data[field];
      }
    }

    await existing.save({ transaction });

    if (data.category_ids !== undefined) {
      await replaceProductCategories(
        existing.product_id,
        data.category_ids,
        data.primary_category_id ?? null,
        transaction,
      );
    } else if (data.primary_category_id !== undefined) {
      const primaryId = data.primary_category_id;

      if (primaryId !== null) {
        const association = await ProductCategory.findOne({
          where: {
            product_id: existing.product_id,
            category_id: primaryId,
          },
          transaction,
        });

        if (!association) {
          throw new HttpError(
            400,
            'The primary category must already be assigned to this product',
          );
        }
      }

      await ProductCategory.update(
        { is_primary: false },
        {
          where: { product_id: existing.product_id },
          transaction,
        },
      );

      if (primaryId !== null) {
        await ProductCategory.update(
          { is_primary: true },
          {
            where: {
              product_id: existing.product_id,
              category_id: primaryId,
            },
            transaction,
          },
        );
      }
    }

    await publishProductCatalog(existing.product_id, transaction);
    return existing;
  });

  res.json({ data: product });
}

export async function deleteProduct(req, res) {
  await sequelize.transaction(async (transaction) => {
    const product = await findProduct(req.validatedParams.productId, transaction);
    await deactivateProductCatalog(product.product_id, transaction);
    await product.destroy({ transaction });
  });
  res.status(204).end();
}

// ======================================================
// UPLOAD PRODUCT IMAGES
// ======================================================

export function uploadImagesProduct(req, res, next) {
  productImageUpload(req, res, async (error) => {
    if (error) return next(new HttpError(400, error.message));
    const createdKeys = [];
    try {
      const files = req.files ?? [];
      if (!files.length)
        throw new HttpError(400, 'Upload at least one image using uploadimage');
      if (files.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024)
        throw new HttpError(400, 'Total image size cannot exceed 10 MB');
      const savedImages = await sequelize.transaction(async (transaction) => {
        const product = await findProduct(req.validatedParams.productId, transaction);
        const existingImages = await models.productImage.findAll({
          where: { product_id: product.product_id },
          transaction,
        });
        if (existingImages.length + files.length > MAX_PRODUCT_IMAGES)
          throw new HttpError(400, 'A product can have a maximum of 6 images');
        const occupiedSlots = new Set(
          existingImages
            .map((image) => getSlotFromKey(product.product_id, image.s3_key))
            .filter(Boolean),
        );
        const availableSlots = IMAGE_SLOTS.filter((slot) => !occupiedSlots.has(slot));
        const saved = [];
        let hasPrimary = existingImages.some((image) => image.is_primary);
        for (const [index, file] of files.entries()) {
          const key = getProductImageKey(
            product.product_id,
            availableSlots[index],
            file.mimetype,
          );
          if (await s3ObjectExists(key))
            throw new HttpError(409, 'Image slot already exists in storage');
          await s3.send(
            new PutObjectCommand({
              Bucket: S3_BUCKET,
              Key: key,
              Body: file.buffer,
              ContentType: file.mimetype,
              CacheControl: 'no-cache',
              IfNoneMatch: '*',
            }),
          );
          createdKeys.push(key);
          saved.push(
            await models.productImage.create(
              {
                product_id: product.product_id,
                image_url: getProductImageUrl(key),
                s3_key: key,
                sort_order:
                  Math.max(-1, ...existingImages.map((image) => image.sort_order)) +
                  index +
                  1,
                is_primary: !hasPrimary,
              },
              { transaction },
            ),
          );
          hasPrimary = true;
        }
        await publishProductCatalog(product.product_id, transaction);
        return saved;
      });
      res.status(201).json({ data: savedImages });
    } catch (uploadError) {
      await Promise.allSettled(
        createdKeys.map((Key) =>
          s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key })),
        ),
      );
      next(uploadError);
    }
  });
}

// ======================================================
// LIST PRODUCT IMAGES
// ======================================================

export async function listProductImages(req, res) {
  const product = await findProduct(req.validatedParams.productId);

  const images = await models.productImage.findAll({
    where: { product_id: product.product_id },
    order: [
      ['is_primary', 'DESC'],
      ['sort_order', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  res.json({ data: images });
}

// ======================================================
// SET PRIMARY PRODUCT IMAGE
// ======================================================

export async function setPrimaryProductImage(req, res) {
  const { productId, imageId } = req.validatedParams;
  const image = await sequelize.transaction(async (transaction) => {
    await findProduct(productId, transaction);
    const selected = await models.productImage.findOne({
      where: { id: imageId, product_id: productId },
      transaction,
    });
    if (!selected) throw new HttpError(404, 'Product image not found');
    await models.productImage.update(
      { is_primary: false },
      { where: { product_id: productId }, transaction },
    );
    const updated = await selected.update({ is_primary: true }, { transaction });
    await publishProductCatalog(productId, transaction);
    return updated;
  });
  res.json({ data: image });
}

// ======================================================
// REPLACE AN EXISTING PRODUCT IMAGE
// ======================================================

export function replaceProductImage(req, res, next) {
  productImageUpload(req, res, async (error) => {
    if (error) {
      return next(new HttpError(400, error.message));
    }

    try {
      const { productId, imageId } = req.validatedParams;

      const files = req.files ?? [];
      if (files.length !== 1)
        throw new HttpError(400, 'Upload exactly one image using uploadimage');
      const file = files[0];
      const updated = await sequelize.transaction(async (transaction) => {
        await findProduct(productId, transaction);
        const image = await models.productImage.findOne({
          where: { id: imageId, product_id: productId },
          transaction,
        });
        if (!image) throw new HttpError(404, 'Product image not found');
        // Retain the storage key and refresh the URL to invalidate browser caches.
        await s3.send(
          new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: image.s3_key,
            Body: file.buffer,
            ContentType: file.mimetype,
            CacheControl: 'no-cache',
          }),
        );
        const updatedImage = await image.update(
          { image_url: `${getProductImageUrl(image.s3_key)}?v=${randomUUID()}` },
          { transaction },
        );
        await publishProductCatalog(productId, transaction);
        return updatedImage;
      });

      return res.json({ data: updated });
    } catch (replaceError) {
      return next(replaceError);
    }
  });
}

// ======================================================
// DELETE A PRODUCT IMAGE
// ======================================================

export async function deleteProductImage(req, res) {
  const { productId, imageId } = req.validatedParams;
  await sequelize.transaction(async (transaction) => {
    await findProduct(productId, transaction);
    const image = await models.productImage.findOne({
      where: { id: imageId, product_id: productId },
      transaction,
    });
    if (!image) throw new HttpError(404, 'Product image not found');
    // Keep the product locked through storage deletion so a new upload cannot reuse its slot.
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: image.s3_key }));
    await image.destroy({ transaction });
    if (image.is_primary) {
      const nextImage = await models.productImage.findOne({
        where: { product_id: productId },
        order: [
          ['sort_order', 'ASC'],
          ['id', 'ASC'],
        ],
        transaction,
      });
      if (nextImage) await nextImage.update({ is_primary: true }, { transaction });
    }
    await publishProductCatalog(productId, transaction);
  });
  res.status(204).end();
}
