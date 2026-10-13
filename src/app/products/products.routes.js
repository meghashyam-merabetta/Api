import { listProducts } from './products.controller.js';
import { listQuerySchema } from './products.schema.js';

export const productRoutes = [
  {
    method: 'get',
    path: '/',
    query: listQuerySchema,
    auth: true,
    handler: listProducts,
  },
];
