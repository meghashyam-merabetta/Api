import { z } from 'zod';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

export function savedItemRoutes(kind) {
  const cart = kind === 'cart';
  const table = cart ? 'customer_cart_items' : 'customer_wishlist_items';
  const params = z.object({ id: z.string().trim().min(1).max(100) }).strict();
  return [
    {
      method: 'get',
      path: '/',
      handler: async (req, res) => {
        const data = await sequelize.query(
          `SELECT item_id AS id${cart ? ',quantity' : ''} FROM ${table} WHERE customer_id=:customer ORDER BY updated_at,item_id`,
          {
            replacements: { customer: req.credential.id },
            type: QueryTypes.SELECT,
          },
        );
        res.json({ data });
      },
    },
    {
      method: 'put',
      path: '/items/:id',
      params,
      schema: cart
        ? z.object({ quantity: z.number().int().min(1).max(99) }).strict()
        : z.object({}).strict(),
      handler: async (req, res) => {
        const id = req.validatedParams.id;
        const quantity = cart ? req.validated.quantity : 1;
        if (cart && id.startsWith('redcliffe:') && quantity !== 1)
          throw new HttpError(422, 'Lab tests require quantity 1');
        await sequelize.transaction(async (transaction) => {
          await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
            replacements: { key: `${kind}:${req.credential.id}` },
            transaction,
          });
          const products = await sequelize.query(
            id.startsWith('redcliffe:')
              ? "SELECT id FROM lab_packages WHERE id=:id AND active AND lab_id='redcliffe'"
              : 'SELECT id FROM product_catalog WHERE id=:id AND active',
            {
              replacements: { id },
              type: QueryTypes.SELECT,
              transaction,
            },
          );
          if (!products.length) throw new HttpError(422, 'Item is no longer available');
          const [count] = await sequelize.query(
            `SELECT count(*)::int AS total FROM ${table} WHERE customer_id=:customer AND item_id<>:id`,
            {
              replacements: { customer: req.credential.id, id },
              type: QueryTypes.SELECT,
              transaction,
            },
          );
          if (count.total >= 200) throw new HttpError(422, 'Maximum 200 saved items');
          await sequelize.query(
            `INSERT INTO ${table}(customer_id,item_id${cart ? ',quantity' : ''}) VALUES(:customer,:id${cart ? ',:quantity' : ''}) ON CONFLICT(customer_id,item_id) DO UPDATE SET updated_at=now()${cart ? ',quantity=EXCLUDED.quantity' : ''}`,
            {
              replacements: { customer: req.credential.id, id, quantity },
              transaction,
            },
          );
        });
        res.json({ id, ...(cart ? { quantity } : {}) });
      },
    },
    {
      method: 'delete',
      path: '/items/:id',
      params,
      handler: async (req, res) => {
        await sequelize.query(
          `DELETE FROM ${table} WHERE customer_id=:customer AND item_id=:id`,
          {
            replacements: { customer: req.credential.id, id: req.validatedParams.id },
          },
        );
        res.status(204).end();
      },
    },
  ];
}
