import { listOrdering, getOrdering } from './ordering.controller.js';
import { orderingQuery, productParams, labParams } from './ordering.schema.js';

export const orderingRoutes = ['labs', 'products'].flatMap(kind => [
  { method: 'get', path: `/${kind}`, query: orderingQuery, handler: listOrdering(kind) },
  { method: 'get', path: `/${kind}/export`, query: orderingQuery, handler: listOrdering(kind, true) },
  { method: 'get', path: `/${kind}/:id`, params: kind === 'labs' ? labParams : productParams, handler: getOrdering(kind) },
]);
