
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';

const Category = models.category;
const Product = models.product;

function getCategoryId(req) {
  return req.validatedParams.categoryId;
}

async function findCategory(categoryId) {
  const category = await Category.findByPk(categoryId);

  if (!category) {
    throw new HttpError(404, 'Category not found');
  }

  return category;
}

async function validateParent(parentCategoryId, currentCategoryId = null) {
  if (parentCategoryId == null) return;

  if (currentCategoryId != null && parentCategoryId === currentCategoryId) {
    throw new HttpError(400, 'A category cannot be its own parent');
  }

  const parent = await Category.findByPk(parentCategoryId);

  if (!parent) {
    throw new HttpError(400, 'Parent category not found');
  }

  // Prevent indirect cycles, e.g. A -> B -> C -> A.
  let ancestor = parent;
  const visited = new Set();

  while (ancestor) {
    const id = ancestor.category_id;

    if (id === currentCategoryId) {
      throw new HttpError(400, 'Category hierarchy cannot contain a cycle');
    }

    if (visited.has(id)) {
      throw new HttpError(400, 'Existing category hierarchy contains a cycle');
    }

    visited.add(id);

    if (ancestor.parent_category_id == null) break;

    ancestor = await Category.findByPk(ancestor.parent_category_id);

    if (!ancestor) {
      throw new HttpError(400, 'Parent category hierarchy is invalid');
    }
  }
}

export async function listCategories(req, res) {
  const {
    limit = 20,
    offset = 0,
    parent_category_id,
  } = req.validatedQuery;

  const where = {};

  if (parent_category_id !== undefined) {
    where.parent_category_id = parent_category_id;
  }

  const { rows, count } = await Category.findAndCountAll({
    where,
    limit,
    offset,
    order: [['category_id', 'ASC']],
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

export async function getCategory(req, res) {
  const category = await findCategory(getCategoryId(req));

  res.json({ data: category });
}

export async function createCategory(req, res) {
  const data = req.validated;

  await validateParent(data.parent_category_id);

  const category = await Category.create({
    category_name: data.category_name,
    category_image: data.category_image ?? null,
    parent_category_id: data.parent_category_id ?? null,
    description: data.description ?? null,
  });

  res.status(201).json({ data: category });
}

export async function updateCategory(req, res) {
  const categoryId = getCategoryId(req);
  const data = req.validated;

  const category = await findCategory(categoryId);

  if (data.parent_category_id !== undefined) {
    await validateParent(data.parent_category_id, categoryId);
  }

  const fields = [
    'category_name',
    'category_image',
    'parent_category_id',
    'description',
  ];

  for (const field of fields) {
    if (Object.hasOwn(data, field)) {
      category[field] = data[field];
    }
  }

  await category.save();

  res.json({ data: category });
}

export async function deleteCategory(req, res) {
  const categoryId = getCategoryId(req);
  const category = await findCategory(categoryId);

  const [productCount, childCount] = await Promise.all([
    Product.count({ where: { category_id: categoryId } }),
    Category.count({ where: { parent_category_id: categoryId } }),
  ]);

  if (productCount > 0) {
    throw new HttpError(
      409,
      'Cannot delete a category that has products assigned to it',
    );
  }

  if (childCount > 0) {
    throw new HttpError(
      409,
      'Cannot delete a category that has subcategories',
    );
  }

  await category.destroy();

  res.status(204).end();
}