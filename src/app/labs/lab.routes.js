import * as schema from './lab.schema.js';
import * as controller from './lab.controller.js';

export const labRoutes = [
  {
    method: 'get',
    path: '/lablisting',
    auth: false,
    query: schema.labListingSchema,
    handler: controller.lablisting,
  },
];
