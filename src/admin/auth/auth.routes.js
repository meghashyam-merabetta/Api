import { loginLimiter } from '../../shared/security.js';
import { adminAuth as controller } from './auth.controller.js';
import * as schema from './auth.schema.js';
const limiter = loginLimiter();
export const authRoutes = [
  {
    method: 'post',
    path: '/login',
    auth: false,
    schema: schema.loginSchema,
    middleware: [limiter],
    handler: controller.login,
  },
  { method: 'get', path: '/me', auth: true, handler: controller.me },
  { method: 'post', path: '/logout', auth: true, handler: controller.logout },
  {
    method: 'post',
    path: '/logout-all',
    auth: true,
    handler: controller.logoutAll,
  },
];
