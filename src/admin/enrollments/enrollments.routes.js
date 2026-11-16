import {
  deleteEnrollment,
  getEnrollment,
  listEnrollments,
  restoreEnrollment,
  updateEnrollment,
  updateEnrollmentStatus,
} from './enrollments.controller.js';
import {
  enrollmentBodySchema,
  enrollmentIdParamsSchema,
  listEnrollmentsQuerySchema,
  updateEnrollmentStatusSchema,
} from './enrollments.schema.js';

export const enrollmentsRoutes = [
  { method: 'get', path: '/', query: listEnrollmentsQuerySchema, handler: listEnrollments },
  { method: 'get', path: '/:id', params: enrollmentIdParamsSchema, handler: getEnrollment },
  {
    method: 'patch',
    path: '/:id/status',
    params: enrollmentIdParamsSchema,
    schema: updateEnrollmentStatusSchema,
    handler: updateEnrollmentStatus,
  },
  {
    method: 'put',
    path: '/:id',
    params: enrollmentIdParamsSchema,
    schema: enrollmentBodySchema,
    handler: updateEnrollment,
  },
  {
    method: 'delete',
    path: '/:id',
    params: enrollmentIdParamsSchema,
    handler: deleteEnrollment,
  },
  {
    method: 'post',
    path: '/:id/restore',
    params: enrollmentIdParamsSchema,
    handler: restoreEnrollment,
  },
];

