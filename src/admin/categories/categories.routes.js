import {
  getCategoryImage,
  uploadCategoryImage,
  deleteCategoryImage,
  categoryTree,
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
} from './categories.controller.js';

import {
  treeQuerySchema,
  listQuerySchema,
  categoryIdParamsSchema,
  createCategorySchema,
  updateCategorySchema,
} from './categories.schema.js';

export const categoriesRoutes = [
  {
    method: 'get',
    path: '/:categoryId/image',
    params: categoryIdParamsSchema,
    auth: true,
    handler: getCategoryImage,
  },
  {
    method: 'post',
    path: '/:categoryId/image',
    params: categoryIdParamsSchema,
    auth: true,
    handler: uploadCategoryImage,
  },
  {
    method: 'put',
    path: '/:categoryId/image',
    params: categoryIdParamsSchema,
    auth: true,
    handler: uploadCategoryImage,
  },
  {
    method: 'delete',
    path: '/:categoryId/image',
    params: categoryIdParamsSchema,
    auth: true,
    handler: deleteCategoryImage,
  },
  {
    method: 'get',
    path: '/tree',
    query: treeQuerySchema,
    auth: true,
    handler: categoryTree,
  },
  {
    method: 'get',
    path: '/',
    query: listQuerySchema,
    auth: true,
    handler: listCategories,
  },
  {
    method: 'get',
    path: '/:categoryId',
    params: categoryIdParamsSchema,
    auth: true,
    handler: getCategory,
  },
  {
    method: 'post',
    path: '/',
    schema: createCategorySchema,
    auth: true,
    handler: createCategory,
  },
  {
    method: 'patch',
    path: '/:categoryId',
    params: categoryIdParamsSchema,
    schema: updateCategorySchema,
    auth: true,
    handler: updateCategory,
  },
  {
    method: 'delete',
    path: '/:categoryId',
    params: categoryIdParamsSchema,
    auth: true,
    handler: deleteCategory,
  },
];
