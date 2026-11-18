import {
  deleteEnrollment,
  getEnrollment,
  listEnrollments,
  restoreEnrollment,
  updateEnrollment,
  updateEnrollmentMedia,
  updateEnrollmentStatus,
} from './enrollments.controller.js';
import {
  enrollmentBodySchema,
  enrollmentIdParamsSchema,
  enrollmentMediaUpdateSchema,
  listEnrollmentsQuerySchema,
  updateEnrollmentStatusSchema,
} from './enrollments.schema.js';

export const enrollmentsRoutes = [
  {
    method: 'put',
    path: '/:id/media',
    params: enrollmentIdParamsSchema,
    schema: enrollmentMediaUpdateSchema,
    handler: updateEnrollmentMedia,
  },
  {
    method: 'get',
    path: '/',
    query: listEnrollmentsQuerySchema,
    handler: listEnrollments,
  },
  {
    method: 'get',
    path: '/:id',
    params: enrollmentIdParamsSchema,
    handler: getEnrollment,
  },
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
