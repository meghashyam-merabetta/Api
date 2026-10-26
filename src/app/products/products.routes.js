import { listProducts, getProduct } from './products.controller.js';
import { listQuerySchema, productParamsSchema } from './products.schema.js';

export const productRoutes = [
  {
    method: 'get',
    path: '/:id',
    params: productParamsSchema,
    auth: true,
    handler: getProduct,
  },
  {
    method: 'get',
    path: '/',
    query: listQuerySchema,
    auth: true,
    handler: listProducts,
  },
];
