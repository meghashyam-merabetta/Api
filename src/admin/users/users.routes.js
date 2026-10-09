import * as schema from './users.schema.js';
import * as controller from './users.controller.js';

export const userRoutes = [
  {
    method: 'get',
    path: '/',
    query: schema.listQuerySchema,
    auth: true,
    handler: controller.listUsers,
  },
];
