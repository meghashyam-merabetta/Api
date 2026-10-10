import { Op } from 'sequelize';
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

  res.json({
    data: rows,
    pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  });
}
