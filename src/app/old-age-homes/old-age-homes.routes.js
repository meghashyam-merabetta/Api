import { z } from 'zod';
import {
  getOldAgeHome,
  getOldAgeHomeCatalog,
  listOldAgeHomes,
} from './old-age-homes.controller.js';

const service = z.enum([
  'assistedLiving',
  'independentLiving',
  'dementiaCare',
  'palliativeCare',
  'homeHospital',
  'dayCareServices',
  'meals',
  'recreationalActivities',
  'other',
]);

export const oldAgeHomeRoutes = [
  {
    method: 'get',
    path: '/catalog',
    auth: false,
    handler: getOldAgeHomeCatalog,
  },
  {
    method: 'get',
    path: '/',
    auth: false,
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
        city: z.string().trim().min(1).max(200).optional(),
        state: z.string().trim().min(1).max(200).optional(),
        service: service.optional(),
        q: z.string().trim().min(1).max(150).optional(),
      })
      .strict(),
    handler: listOldAgeHomes,
  },
  {
    method: 'get',
    path: '/:id',
    auth: false,
    params: z.object({ id: z.uuid() }).strict(),
    handler: getOldAgeHome,
  },
];
