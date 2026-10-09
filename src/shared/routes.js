import { Router } from 'express';
import { asyncHandler } from './async-handler.js';
import { validateBody, validateParams, validateQuery } from './validation.js';
export function buildRouter(authenticate, definitions) {
  const router = Router();
  for (const {
    method,
    path,
    auth = true,
    schema,
    params,
    query,
    middleware = [],
    handler,
  } of definitions) {
    if (typeof auth !== 'boolean')
      throw new TypeError('Route auth must be true or false');
    if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))
      throw new TypeError('Invalid route method: ' + method);
    if (typeof handler !== 'function') throw new TypeError('Route handler is required');
    router[method](
      path,
      ...(auth ? [asyncHandler(authenticate)] : []),
      ...middleware,
      ...(params ? [validateParams(params)] : []),
      ...(query ? [validateQuery(query)] : []),
      ...(schema ? [validateBody(schema)] : []),
      asyncHandler(handler),
    );
  }
  return router;
}
