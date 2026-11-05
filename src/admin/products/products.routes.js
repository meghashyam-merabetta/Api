
import { inventoryRoutes } from '../inventory/inventory.routes.js';

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

// ============================================
// MERABETTA - PRODUCT API ROUTES
// ============================================

// Each products.id represents one independent
// purchasable product/variant.
//
// Product details: product_details
// Warehouse stock: product_inventory
// Images: existing AWS S3 image system
//
// No parent_product_id.
// No dependency on product_variants.
// No base_price.

// ============================================
// PRODUCT ROUTES
// ============================================

export const productsRoutes = [
  // ==========================================
  // WAREHOUSE INVENTORY & RELATED PRODUCTS
  // ==========================================

  ...inventoryRoutes,

  // ==========================================
  // PRODUCT CRUD
  // ==========================================

  // GET /api/admin/products
  {
    method: 'get',
    path: '/',
    query: listQuerySchema,
    auth: true,
    handler: listProducts,
  },

  // GET /api/admin/products/:productId
  {
    method: 'get',
    path: '/:productId',
    params: productIdParamsSchema,
    auth: true,
    handler: getProduct,
  },

  // POST /api/admin/products
  {
    method: 'post',
    path: '/',
    schema: createProductSchema,
    auth: true,
    handler: createProduct,
  },

  // PATCH /api/admin/products/:productId
  {
    method: 'patch',
    path: '/:productId',
    params: productIdParamsSchema,
    schema: updateProductSchema,
    auth: true,
    handler: updateProduct,
  },

  // DELETE /api/admin/products/:productId
  {
    method: 'delete',
    path: '/:productId',
    params: productIdParamsSchema,
    auth: true,
    handler: deleteProduct,
  },

  // ==========================================
  // PRODUCT IMAGE MANAGEMENT
  // EXISTING AWS S3 IMPLEMENTATION
  // ==========================================

  // POST /api/admin/products/:productId/images
  {
    method: 'post',
    path: '/:productId/images',
    params: productIdParamsSchema,
    auth: true,
    handler: uploadImagesProduct,
  },

  // GET /api/admin/products/:productId/images
  {
    method: 'get',
    path: '/:productId/images',
    params: productIdParamsSchema,
    auth: true,
    handler: listProductImages,
  },

  // PATCH /api/admin/products/:productId/images/:imageId/primary
  {
    method: 'patch',
    path: '/:productId/images/:imageId/primary',
    params: productImageParamsSchema,
    auth: true,
    handler: setPrimaryProductImage,
  },

  // PUT /api/admin/products/:productId/images/:imageId
  {
    method: 'put',
    path: '/:productId/images/:imageId',
    params: productImageParamsSchema,
    auth: true,
    handler: replaceProductImage,
  },

  // DELETE /api/admin/products/:productId/images/:imageId
  {
    method: 'delete',
    path: '/:productId/images/:imageId',
    params: productImageParamsSchema,
    auth: true,
    handler: deleteProductImage,
  },
];
