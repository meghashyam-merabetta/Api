import {
  createLab,
  deleteLab,
  getLab,
  getLabImage,
  listLabs,
  updateLab,
  uploadLabImage,
} from './labs.controller.js';
import {
  createLabSchema,
  labIdParamsSchema,
  listLabsQuerySchema,
  updateLabSchema,
} from './labs.schema.js';

export const labsRoutes = [
  {
    method: 'get',
    path: '/:labId/image',
    params: labIdParamsSchema,
    handler: getLabImage,
  },
  {
    method: 'post',
    path: '/:labId/image',
    params: labIdParamsSchema,
    handler: uploadLabImage,
  },
  {
    method: 'put',
    path: '/:labId/image',
    params: labIdParamsSchema,
    handler: uploadLabImage,
  },
  { method: 'get', path: '/', query: listLabsQuerySchema, handler: listLabs },
  { method: 'post', path: '/', schema: createLabSchema, handler: createLab },
  { method: 'get', path: '/:labId', params: labIdParamsSchema, handler: getLab },
  {
    method: 'patch',
    path: '/:labId',
    params: labIdParamsSchema,
    schema: updateLabSchema,
    handler: updateLab,
  },
  { method: 'delete', path: '/:labId', params: labIdParamsSchema, handler: deleteLab },
];
