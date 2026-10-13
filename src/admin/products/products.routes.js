import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from './products.controller.js';

import {
  listQuerySchema,
  productIdParamsSchema,
  createProductSchema,
  updateProductSchema,
} from './products.schema.js';

export const productsRoutes = [
  {
    method: 'get',
    path: '/',
    query: listQuerySchema,
    auth: true,
    handler: listProducts,
  },
  {
    method: 'get',
    path: '/:productId',
    params: productIdParamsSchema,
    auth: true,
    handler: getProduct,
  },
  {
    method: 'post',
    path: '/',
    schema: createProductSchema,
    auth: true,
    handler: createProduct,
  },
  {
    method: 'patch',
    path: '/:productId',
    params: productIdParamsSchema,
    schema: updateProductSchema,
    auth: true,
    handler: updateProduct,
  },
  {
    method: 'delete',
    path: '/:productId',
    params: productIdParamsSchema,
    auth: true,
    handler: deleteProduct,
  },
];
