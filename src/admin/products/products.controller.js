import { Op } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';

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