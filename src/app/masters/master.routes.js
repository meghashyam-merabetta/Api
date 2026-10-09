import * as schema from './master.schema.js';
import * as controller from './master.controller.js';

export const masterRoutes = [
  {
    method: 'get',
    path: '/public',
    auth: false,
    handler: controller.getPublic,
  },
  { method: 'get', path: '/faqs', auth: false, handler: controller.listFaqs },
  { method: 'get', path: '/states', auth: false, handler: controller.listStates },
  {
    method: 'get',
    path: '/states/:stateId/cities',
    auth: false,
    params: schema.stateParamsSchema,
    handler: controller.listCities,
  },
];
