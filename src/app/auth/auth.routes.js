import { loginLimiter } from '../../shared/security.js';
import * as schema from './auth.schema.js';
import * as controller from './auth.controller.js';

export const authRoutes = [
  {
    method: 'post',
    path: '/otp/request',
    auth: false,
    schema: schema.requestOtpSchema,
    middleware: [loginLimiter()],
    handler: controller.requestOtp,
  },
  {
    method: 'post',
    path: '/otp/verify',
    auth: false,
    schema: schema.verifyOtpSchema,
    middleware: [loginLimiter()],
    handler: controller.verifyOtp,
  },
  { method: 'get', path: '/me', auth: true, handler: controller.me },
  { method: 'post', path: '/logout', auth: true, handler: controller.logout },
  { method: 'post', path: '/logout-all', auth: true, handler: controller.logoutAll },
];
