import {
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
} from './categories.controller.js';

import {
  listQuerySchema,
  categoryIdParamsSchema,
  createCategorySchema,
  updateCategorySchema,
} from './categories.schema.js';

export const categoriesRoutes = [
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
