import { rateLimit } from 'express-rate-limit';
import {
  enrollmentBodySchema,
  enrollmentAbortUploadSchema,
  enrollmentChunkedSubmissionSchema,
  enrollmentChunkInitiateSchema,
  enrollmentCompleteUploadSchema,
  enrollmentMultipartBodySchema,
  enrollmentPartUrlSchema,
} from '../../admin/enrollments/enrollments.schema.js';
import {
  createEnrollment,
  createEnrollmentFromReceipts,
  createEnrollmentWithFiles,
} from './enrollments.controller.js';
import { enrollmentMultipart } from './enrollment-upload.js';
import {
  abortEnrollmentFile,
  completeEnrollmentFile,
  createEnrollmentUploadSession,
  getEnrollmentPartUrl,
  initiateEnrollmentFile,
} from './enrollment-chunks.js';

const enrollmentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many enrollment submissions; try again later' },
});
const enrollmentChunkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many enrollment upload operations; try again later' },
});

export const appEnrollmentsRoutes = [
  {
    method: 'post',
    path: '/upload-sessions',
    auth: false,
    middleware: [enrollmentChunkLimiter],
    handler: createEnrollmentUploadSession,
  },
  {
    method: 'post',
    path: '/upload-sessions/files',
    auth: false,
    middleware: [enrollmentChunkLimiter],
    schema: enrollmentChunkInitiateSchema,
    handler: initiateEnrollmentFile,
  },
  {
    method: 'post',
    path: '/upload-sessions/part-url',
    auth: false,
    middleware: [enrollmentChunkLimiter],
    schema: enrollmentPartUrlSchema,
    handler: getEnrollmentPartUrl,
  },
  {
    method: 'post',
    path: '/upload-sessions/complete',
    auth: false,
    middleware: [enrollmentChunkLimiter],
    schema: enrollmentCompleteUploadSchema,
    handler: completeEnrollmentFile,
  },
  {
    method: 'delete',
    path: '/upload-sessions/file',
    auth: false,
    middleware: [enrollmentChunkLimiter],
    schema: enrollmentAbortUploadSchema,
    handler: abortEnrollmentFile,
  },
  {
    method: 'post',
    path: '/with-uploaded-files',
    auth: false,
    middleware: [enrollmentLimiter],
    schema: enrollmentChunkedSubmissionSchema,
    handler: createEnrollmentFromReceipts,
  },
  {
    method: 'post',
    path: '/with-files',
    auth: false,
    middleware: [enrollmentLimiter, enrollmentMultipart],
    schema: enrollmentMultipartBodySchema,
    handler: createEnrollmentWithFiles,
  },
  {
    method: 'post',
    path: '/',
    auth: false,
    middleware: [enrollmentLimiter],
    schema: enrollmentBodySchema,
    handler: createEnrollment,
  },
];
