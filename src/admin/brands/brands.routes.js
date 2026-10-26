import { z } from 'zod';
import { Op } from 'sequelize';
import { Brand, Product } from '../../models/index.js';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
const fields = {
  brand_name: z.string().trim().min(1).max(150),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(10000).nullable().optional(),
  image_url: z.url().nullable().optional(),
  is_active: z.boolean().optional(),
};
const create = z.object(fields).strict();
const update = create
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field');
const params = z.object({ brandId: z.coerce.number().int().positive() }).strict();
const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    search: z.string().trim().min(1).max(150).optional(),
    is_active: z.enum(['true', 'false']).optional(),
    all: z.enum(['true', 'false']).optional(),
  })
  .strict();
async function find(id, transaction) {
  const brand = await Brand.findByPk(id, {
    transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!brand) throw new HttpError(404, 'Brand not found');
  return brand;
}
export const brandsRoutes = [
  {
    method: 'get',
    path: '/',
    query,
    handler: async (req, res) => {
      const { limit, offset, search, is_active, all } = req.validatedQuery;
      const where = {};
      if (search) where.brand_name = { [Op.iLike]: `%${search}%` };
      if (is_active !== undefined) where.is_active = is_active === 'true';
      const { rows, count } = await Brand.findAndCountAll({
        where,
        ...(all === 'true' ? {} : { limit, offset }),
        order: [
          ['brand_name', 'ASC'],
          ['brand_id', 'ASC'],
        ],
      });
      res.json({
        data: rows,
        pagination: {
          total: count,
          limit: all === 'true' ? count : limit,
          offset: all === 'true' ? 0 : offset,
          hasMore: all === 'true' ? false : offset + rows.length < count,
        },
      });
    },
  },
  {
    method: 'get',
    path: '/:brandId',
    params,
    handler: async (req, res) =>
      res.json({ data: await find(req.validatedParams.brandId) }),
  },
  {
    method: 'post',
    path: '/',
    schema: create,
    handler: async (req, res) =>
      res.status(201).json({ data: await Brand.create(req.validated) }),
  },
  {
    method: 'patch',
    path: '/:brandId',
    params,
    schema: update,
    handler: async (req, res) =>
      res.json({
        data: await (await find(req.validatedParams.brandId)).update(req.validated),
      }),
  },
  {
    method: 'delete',
    path: '/:brandId',
    params,
    handler: async (req, res) => {
      await sequelize.transaction(async (transaction) => {
        const brand = await find(req.validatedParams.brandId, transaction);
        if (await Product.count({ where: { brand_id: brand.brand_id }, transaction }))
          throw new HttpError(409, 'Cannot delete a brand assigned to products');
        await brand.destroy({ transaction });
      });
      res.status(204).end();
    },
  },
];
