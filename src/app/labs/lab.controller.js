import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';

export async function lablisting(req, res) {
  const { page, limit, search, city, homeCollection } = req.validatedQuery;
  const where = {};

  if (search) {
    // Treat wildcard characters as ordinary search text.
    const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
    where[Op.or] = [{ name: { [Op.iLike]: pattern } }, { city: { [Op.iLike]: pattern } }];
  }
  if (city) where.city = city;
  if (homeCollection !== undefined) where.homeCollection = homeCollection;

  const { rows, count } = await models.lab.findAndCountAll({
    where,
    attributes: [
      'id',
      'name',
      'description',
      'rating',
      'image',
      'color',
      'bg',
      'active',
      'city',
      'homeCollection',
    ],
    order: [
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
    limit,
    offset: (page - 1) * limit,
  });

  const counts = rows.length ? await sequelize.query(
    'SELECT lab_id,count(*)::int AS count FROM lab_packages WHERE active AND lab_id IN (:ids) GROUP BY lab_id',
    { replacements: { ids: rows.map(row => row.id) }, type: QueryTypes.SELECT },
  ) : [];
  const totals = new Map(counts.map(row => [row.lab_id, row.count]));
  res.json({
    data: rows.map(row => ({ ...row.toJSON(), testCount: totals.get(row.id) || 0 })),
    pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  });
}
