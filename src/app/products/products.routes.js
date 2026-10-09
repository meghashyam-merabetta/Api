import * as schema from './products.schema.js';
import * as controller from './products.controller.js';

export const productRoutes = [
  {
    method: 'get',
    path: '/',
    query: schema.listQuerySchema,
    auth: false,
    handler: controller.listProducts,
  },
];
