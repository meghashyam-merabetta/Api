import { productVariantRoutes } from '../variants/variants.routes.js';
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  uploadImagesProduct,
  listProductImages,
  setPrimaryProductImage,
  replaceProductImage,
  deleteProductImage,
} from './products.controller.js';

import {
  listQuerySchema,
  productIdParamsSchema,
  productImageParamsSchema,
  createProductSchema,
  updateProductSchema,
} from './products.schema.js';

export const productsRoutes = [
  ...productVariantRoutes,
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
  {
    method: 'post',
    path: '/:productId/images',
    params: productIdParamsSchema,
    auth: true,
    handler: uploadImagesProduct,
  },
  {
    method: 'get',
    path: '/:productId/images',
    params: productIdParamsSchema,
    auth: true,
    handler: listProductImages,
  },
  {
    method: 'patch',
    path: '/:productId/images/:imageId/primary',
    params: productImageParamsSchema,
    auth: true,
    handler: setPrimaryProductImage,
  },
  {
    method: 'delete',
    path: '/:productId/images/:imageId',
    params: productImageParamsSchema,
    auth: true,
    handler: deleteProductImage,
  },
  {
    method: 'put',
    path: '/:productId/images/:imageId',
    params: productImageParamsSchema,
    auth: true,
    handler: replaceProductImage,
  },
];
