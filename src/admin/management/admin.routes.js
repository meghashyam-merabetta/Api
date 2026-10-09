import { buildRouter } from '../../shared/routes.js';
import { adminAuth } from '../auth/auth.controller.js';
import * as schema from './admin.schema.js';
import * as controller from './admin.controller.js';
import { devAdminAuth } from '../../shared/dev-admin-auth.js';

export const adminManagementRoutes = [
  {
    method: 'get',
    path: '/',
    query: schema.listQuerySchema,
    auth: false,
    middleware: [devAdminAuth],
    handler: controller.listAdmins,
  },

  {
    method: 'get',
    path: '/:id',
    params: schema.recordIdSchema,
    auth: false,
    middleware: [devAdminAuth],
    handler: controller.getAdmin,
  },

  {
    method: 'post',
    path: '/',
    schema: schema.createAdminSchema,
    auth: false,
    middleware: [devAdminAuth],
    handler: controller.createAdmin,
  },

  {
    method: 'put',
    path: '/:id',
    params: schema.recordIdSchema,
    schema: schema.updateAdminSchema,
    auth: false,
    middleware: [devAdminAuth],
    handler: controller.updateAdmin,
  },

  {
    method: 'delete',
    path: '/:id',
    params: schema.recordIdSchema,
    auth: false,
    middleware: [devAdminAuth],
    handler: controller.deleteAdmin,
  },

  {
    method: 'patch',
    path: '/:id/password',
    params: schema.recordIdSchema,
    schema: schema.changePasswordSchema,
    auth: false,
    middleware: [devAdminAuth],
    handler: controller.changeAdminPassword,
  },
];

export const buildAdminManagementRouter = (
  authenticate = adminAuth.authenticate,
) => buildRouter(authenticate, adminManagementRoutes);

