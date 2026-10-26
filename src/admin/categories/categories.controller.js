import { Op } from 'sequelize';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';

const Category = models.category;
const ProductCategory = models.productCategory;

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

async function validateParent(parentId, currentId = null) {
  if (parentId === null || parentId === undefined) {
    return;
  }

  if (
    currentId !== null &&
    currentId !== undefined &&
    String(parentId) === String(currentId)
  ) {
    throw new HttpError(400, 'A category cannot be its own parent');
  }

  let ancestor = await Category.findByPk(parentId);

  if (!ancestor) {
    throw new HttpError(400, 'Parent category not found');
  }

  const visited = new Set();

  while (ancestor) {
    const id = String(ancestor.category_id);

    if (id === String(currentId)) {
      throw new HttpError(400, 'Category hierarchy cannot contain a cycle');
    }

    if (visited.has(id)) {
      throw new HttpError(400, 'Existing category hierarchy contains a cycle');
    }

    visited.add(id);

    if (
      ancestor.parent_category_id === null ||
      ancestor.parent_category_id === undefined
    ) {
      break;
    }

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
    roots_only,
    search,
    is_active,
  } = req.validatedQuery;

  const where = {};

  if (roots_only === 'true' && parent_category_id !== undefined)
    throw new HttpError(400, 'Choose roots_only or parent_category_id');
  if (roots_only === 'true') where.parent_category_id = null;

  if (parent_category_id !== undefined) {
    where.parent_category_id = parent_category_id;
  }

  if (search) {
    where.category_name = { [Op.iLike]: `%${search}%` };
  }

  if (is_active !== undefined) {
    where.is_active = is_active === 'true';
  }

  const { rows, count } = await Category.findAndCountAll({
    where,
    limit,
    offset,
    order: [
      ['sort_order', 'ASC'],
      ['category_id', 'ASC'],
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

export async function getCategory(req, res) {
  const category = await findCategory(getCategoryId(req));

  res.json({ data: category });
}

export async function createCategory(req, res) {
  const data = req.validated;

  await validateParent(data.parent_category_id);

  const category = await Category.create({
    category_name: data.category_name,
    slug: data.slug,
    category_image: data.category_image ?? null,
    parent_category_id: data.parent_category_id ?? null,
    description: data.description ?? null,
    sort_order: data.sort_order ?? 0,
    is_active: data.is_active ?? true,
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
    'slug',
    'category_image',
    'parent_category_id',
    'description',
    'sort_order',
    'is_active',
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
    ProductCategory.count({
      where: { category_id: categoryId },
    }),
    Category.count({
      where: { parent_category_id: categoryId },
    }),
  ]);

  if (productCount > 0) {
    throw new HttpError(409, 'Cannot delete a category that has products assigned to it');
  }

  if (childCount > 0) {
    throw new HttpError(409, 'Cannot delete a category that has subcategories');
  }

  await category.destroy();

  res.status(204).end();
}
export async function categoryTree(req, res) {
  const where = {};
  if (req.validatedQuery.is_active !== undefined)
    where.is_active = req.validatedQuery.is_active === 'true';
  const rows = await Category.findAll({
    where,
    order: [
      ['sort_order', 'ASC'],
      ['category_name', 'ASC'],
      ['category_id', 'ASC'],
    ],
  });
  const nodes = new Map(
    rows.map((row) => [String(row.category_id), { ...row.toJSON(), subcategories: [] }]),
  );
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parent_category_id === null || node.parent_category_id === undefined)
      roots.push(node);
    else nodes.get(String(node.parent_category_id))?.subcategories.push(node);
  }
  // Detect corrupt persisted hierarchies before serializing a recursive response.
  const visited = new Set();
  for (const row of rows) {
    let node = nodes.get(String(row.category_id));
    const path = new Set();
    while (node && !visited.has(String(node.category_id))) {
      const id = String(node.category_id);
      if (path.has(id)) throw new HttpError(409, 'Category hierarchy contains a cycle');
      path.add(id);
      node = nodes.get(String(node.parent_category_id));
    }
    for (const id of path) visited.add(id);
  }
  res.json({ data: roots });
}
