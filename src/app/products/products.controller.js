import { Op } from 'sequelize';
import { ProductCatalog } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
export async function listProducts(req, res) {
  const { limit, offset, search, category_id } = req.validatedQuery;
  const where = { active: true };
  if (search) where['data.name'] = { [Op.iLike]: `%${search}%` };
  if (category_id)
    where[Op.or] = [
      { data: { [Op.contains]: { category_ids: [category_id] } } },
      { data: { [Op.contains]: { categoryId: category_id } } },
    ];
  const { rows, count } = await ProductCatalog.findAndCountAll({
    where,
    limit,
    offset,
    order: [['id', 'ASC']],
  });
  res.json({
    data: rows.map((row) => ({ ...row.data, id: row.id })),
    pagination: { total: count, limit, offset, hasMore: offset + rows.length < count },
  });
}
export async function getProduct(req, res) {
  const row = await ProductCatalog.findOne({
    where: { id: req.validatedParams.id, active: true },
  });
  if (!row) throw new HttpError(404, 'Product not found');
  res.json({ data: { ...row.data, id: row.id } });
}
