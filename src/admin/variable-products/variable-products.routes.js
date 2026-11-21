import {
  createVariableProductSchema,
  updateVariableProductSchema,
  variableProductParamsSchema,
} from './variable-products.schema.js';

// Authentication is supplied by the existing admin realm in routes/index.js.
export function variableProductRoutes(handlers) {
  return [
    {
      method: 'post',
      path: '/',
      auth: true,
      schema: createVariableProductSchema,
      handler: handlers.create,
    },
    {
      method: 'get',
      path: '/:id',
      auth: true,
      params: variableProductParamsSchema,
      handler: handlers.get,
    },
    {
      method: 'patch',
      path: '/:id',
      auth: true,
      params: variableProductParamsSchema,
      schema: updateVariableProductSchema,
      handler: handlers.update,
    },
  ];
}
