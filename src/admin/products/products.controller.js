import { Op } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import {
  productImageUpload,
  s3,
} from './product_image.js';

import {
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

import { randomUUID } from 'node:crypto';

const Product = models.product;
const Category = models.category;
const ProductCategory = models.productCategory;

async function findProduct(productId, transaction) {
  const product = await Product.findByPk(productId, { transaction });

  if (!product) {
    throw new HttpError(404, 'Product not found');
  }

  return product;
}

async function validateCategories(categoryIds, transaction) {
  const ids = [...new Set(categoryIds.map(String))];

  if (ids.length === 0) {
    return;
  }

  const categories = await Category.findAll({
    where: { category_id: { [Op.in]: ids } },
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
    throw new HttpError(
      400,
      'The primary category must be included in category_ids',
    );
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

export async function listProducts(req, res) {
  const {
    limit = 20,
    offset = 0,
    category_id,
    search,
    product_status,
  } = req.validatedQuery;

  const where = {};

  if (search) {
    where.product_name = { [Op.iLike]: `%${search}%` };
  }

  if (product_status) {
    where.product_status = product_status;
  }

  const include = [
    {
      model: Category,
      as: 'categories',
      through: { attributes: ['is_primary'] },
      required: category_id !== undefined,
      ...(category_id !== undefined
        ? { where: { category_id } }
        : {}),
    },
  ];

  const { rows, count } = await Product.findAndCountAll({
    where,
    include,
    distinct: true,
    limit,
    offset,
    order: [['product_id', 'ASC']],
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
    ],
  });

  res.json({ data: result });
}

export async function createProduct(req, res) {
  const data = req.validated;

  const product = await sequelize.transaction(async (transaction) => {
    const categoryIds = data.category_ids ?? [];
    const primaryCategoryId = data.primary_category_id ?? null;

    await validateCategories(categoryIds, transaction);

    const created = await Product.create(
      {
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

    return created;
  });

  res.status(201).json({ data: product });
}

export async function updateProduct(req, res) {
  const data = req.validated;

  const product = await sequelize.transaction(async (transaction) => {
    const existing = await findProduct(
      req.validatedParams.productId,
      transaction,
    );

    const fields = [
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

    return existing;
  });

  res.json({ data: product });
}

export async function deleteProduct(req, res) {
  const product = await findProduct(req.validatedParams.productId);

  await product.destroy();

  res.status(204).end();
}


const S3_BUCKET = 'prod-merabetta';
const S3_REGION = 'ap-south-1';

export function uploadImagesProduct(req, res, next) {
  productImageUpload(req, res, async (error) => {
    if (error) {
      return next(error);
    }

    try {
      const product = await findProduct(
        req.validatedParams.productId,
      );

      const files = req.files ?? [];

      if (files.length === 0) {
        return res.status(400).json({
          message: 'Upload at least one image using uploadimage',
        });
      }

      const existingCount = await models.productImage.count({
        where: { product_id: product.product_id },
      });

      if (existingCount + files.length > 6) {
        return res.status(400).json({
          message: 'A product can have a maximum of 6 images',
        });
      }

      const uploaded = [];

      try {
        for (const [index, file] of files.entries()) {
          const extensionByMimeType = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
          };

          const extension = extensionByMimeType[file.mimetype];

          if (!extension) {
            throw new HttpError(400, 'Unsupported image type');
          }

          const s3Key =
            `upload/${product.product_id}/${randomUUID()}.${extension}`;

          await s3.send(
            new PutObjectCommand({
              Bucket: S3_BUCKET,
              Key: s3Key,
              Body: file.buffer,
              ContentType: file.mimetype,
            }),
          );

          const imageUrl =
            `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${s3Key}`;

          uploaded.push({
            product_id: product.product_id,
            image_url: imageUrl,
            s3_key: s3Key,
            alt_text: null,
            sort_order: existingCount + index,
            is_primary: existingCount === 0 && index === 0,
          });
        }

        const saved = await sequelize.transaction(async (transaction) => {
          return models.productImage.bulkCreate(uploaded, {
            transaction,
          });
        });

        return res.status(201).json({
          data: saved,
        });
      } catch (uploadError) {
        await Promise.allSettled(
          uploaded.map((image) =>
            s3.send(
              new DeleteObjectCommand({
                Bucket: S3_BUCKET,
                Key: image.s3_key,
              }),
            ),
          ),
        );

        throw uploadError;
      }
    } catch (uploadError) {
      return next(uploadError);
    }
  });
}


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

export async function setPrimaryProductImage(req, res) {
  const { productId, imageId } = req.validatedParams;
  const product = await findProduct(productId);

  const image = await models.productImage.findOne({
    where: {
      id: imageId,
      product_id: product.product_id,
    },
  });

  if (!image) {
    throw new HttpError(404, 'Product image not found');
  }

  await sequelize.transaction(async (transaction) => {
    // Clear the existing primary before setting the new one.
    await models.productImage.update(
      { is_primary: false },
      {
        where: { product_id: product.product_id },
        transaction,
      },
    );

    await image.update(
      { is_primary: true },
      { transaction },
    );
  });

  res.json({ data: { ...image.toJSON(), is_primary: true } });
}

export async function deleteProductImage(req, res) {
  const { productId, imageId } = req.validatedParams;
  const product = await findProduct(productId);

  const image = await models.productImage.findOne({
    where: {
      id: imageId,
      product_id: product.product_id,
    },
  });

  if (!image) {
    throw new HttpError(404, 'Product image not found');
  }

  const wasPrimary = image.is_primary;

  // Remove the database row first, then remove the S3 object.
  await sequelize.transaction(async (transaction) => {
    await image.destroy({ transaction });

    if (wasPrimary) {
      const nextImage = await models.productImage.findOne({
        where: { product_id: product.product_id },
        order: [['sort_order', 'ASC'], ['id', 'ASC']],
        transaction,
      });

      if (nextImage) {
        await nextImage.update(
          { is_primary: true },
          { transaction },
        );
      }
    }
  });

  await s3.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: image.s3_key,
    }),
  );

  res.status(204).end();
}
