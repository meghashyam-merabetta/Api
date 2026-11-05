import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { listProducts, getProduct } from './products.controller.js';
import { productCatalog } from './catalog.js';
const placeholder = readFileSync(new URL('./image-unavailable.png', import.meta.url));
export const productRoutes = [
  {
    method: 'get',
    path: '/image-unavailable.png',
    auth: false,
    handler: (_req, res) => res.type('png').send(placeholder),
  },
  {
    method: 'get',
    path: '/catalog',
    auth: false,
    handler: async (req, res) => {
      const data = await productCatalog();
      const protocol =
        req.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'
          ? 'https'
          : req.protocol;
      for (const product of data.products)
        if (!product.image)
          product.image = `${protocol}://${req.get('host')}/api/app/products/image-unavailable.png`;
      res.json({ data });
    },
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
    params: z.object({ id: z.string().regex(/^product:\d+$/) }),
    handler: getProduct,
  },
];
