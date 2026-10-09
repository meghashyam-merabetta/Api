import * as schema from './cart.schema.js';
import * as controller from './cart.controller.js';

export const cartRoutes = [
  {
    method: 'get',
    path: '/',
    query: schema.listQuerySchema,
    auth: true,
    handler: controller.getCart,
  },
];
