import { z } from 'zod';
import { query } from './store.js';
export const vendorRoutes = [
  {
    method: 'get',
    path: '/',
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
        search: z.string().trim().max(150).optional(),
      })
      .strict(),
    handler: async (req, res) => {
      const { limit, offset, search } = req.validatedQuery;
      const args = { limit, offset, search: `%${search ?? ''}%` };
      const where = "vendor_status='active' AND name ILIKE :search";
      const [{ total }] = await query(
        `SELECT count(*)::int total FROM vendors WHERE ${where}`,
        args,
      );
      const data = await query(
        `SELECT id::text,name,vendor_status FROM vendors WHERE ${where} ORDER BY name,id LIMIT :limit OFFSET :offset`,
        args,
      );
      res.json({
        data,
        pagination: { total, limit, offset, hasMore: offset + data.length < total },
      });
    },
  },
];
