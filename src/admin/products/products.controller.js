
import { Op } from 'sequelize';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';

const Product = models.product;
const Category = models.category;

async function findProduct(productId) {
  const product = await Product.findByPk(productId);

  if (!product) {
    throw new HttpError(404, 'Product not found');
  }

  return product;
}

async function validateCategory(categoryId) {
  if (categoryId == null) return;

  const category = await Category.findByPk(categoryId);

  if (!category) {
    throw new HttpError(400, 'Category not found');
  }
}

export async function listProducts(req, res) {
  const {
    limit = 20,
    offset = 0,
    category_id,
    search,
  } = req.validatedQuery;

  const where = {};

  if (category_id !== undefined) {
    where.category_id = category_id;
  }

  if (search) {
    where.product_name = { [Op.iLike]: `%${search}%` };
  }

  const { rows, count } = await Product.findAndCountAll({
    where,
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

  res.json({ data: product });
}

export async function createProduct(req, res) {
  const data = req.validated;

  await validateCategory(data.category_id);

  const product = await Product.create({
    product_name: data.product_name,
    prescription_required: data.prescription_required ?? false,
    age_group: data.age_group ?? null,
    description: data.description ?? null,
    category_id: data.category_id ?? null,
  });

  res.status(201).json({ data: product });
}

export async function updateProduct(req, res) {
  const product = await findProduct(req.validatedParams.productId);
  const data = req.validated;

  if (data.category_id !== undefined) {
    await validateCategory(data.category_id);
  }

  const fields = [
    'product_name',
    'prescription_required',
    'age_group',
    'description',
    'category_id',
  ];

  for (const field of fields) {
    if (Object.hasOwn(data, field)) {
      product[field] = data[field];
    }
  }

  await product.save();

  res.json({ data: product });
}

export async function deleteProduct(req, res) {
  const product = await findProduct(req.validatedParams.productId);

  await product.destroy();

  res.status(204).end();
}