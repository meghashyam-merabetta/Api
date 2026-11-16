import { rateLimit } from 'express-rate-limit';
import { enrollmentBodySchema } from '../../admin/enrollments/enrollments.schema.js';
import { createEnrollment } from './enrollments.controller.js';

const enrollmentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many enrollment submissions; try again later' },
});

export const appEnrollmentsRoutes = [
  {
    method: 'post',
    path: '/',
    auth: false,
    middleware: [enrollmentLimiter],
    schema: enrollmentBodySchema,
    handler: createEnrollment,
  },
];

