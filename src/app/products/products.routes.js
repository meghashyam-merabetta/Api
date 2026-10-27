import { z } from 'zod';
import { listProducts, getProduct } from './products.controller.js';
import { productCatalog } from './catalog.js';
export const productRoutes = [
  {
    method: 'get',
    path: '/catalog',
    auth: false,
    handler: async (_req, res) => res.json({ data: await productCatalog() }),
  },
  {
    method: 'get',
    path: '/categories',
    auth: false,
    handler: async (_req, res) => res.json({ data: (await productCatalog()).categories }),
  },
  {
    method: 'get',
    path: '/brands',
    auth: false,
    handler: async (_req, res) => res.json({ data: (await productCatalog()).brands }),
  },
  {
    method: 'get',
    path: '/',
    auth: false,
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
        category: z.string().optional(),
        brand: z.string().optional(),
        q: z.string().trim().max(150).optional(),
      })
      .strict(),
    handler: listProducts,
  },
  {
    method: 'get',
    path: '/:id',
    auth: false,
    params: z.object({ id: z.string().regex(/^shop:\d+$/) }),
    handler: getProduct,
  },
];