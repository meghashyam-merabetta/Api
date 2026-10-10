import { z } from 'zod';
import { catalog, parameters } from './catalog.js';
import { collectionDates, slots } from './slots.js';

export const redcliffeRoutes = [
  { method: 'get', path: '/catalog', handler: catalog },
  {
    method: 'get',
    path: '/packages/:code/parameters',
    params: z.object({ code: z.string().min(1).max(85) }).strict(),
    handler: parameters,
  },
  {
    method: 'get',
    path: '/dates',
    handler: (_req, res) =>
      res.json({ dates: collectionDates(), timeZone: 'Asia/Kolkata' }),
  },
  {
    method: 'get',
    path: '/slots',
    query: z
      .object({
        collectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        latitude: z.coerce.number().min(-85).max(85),
        longitude: z.coerce.number().min(-180).max(180),
      })
      .strict(),
    handler: slots,
  },
];
