import { z } from 'zod';

export const stateParamsSchema = z
  .object({
    stateId: z.uuid(),
  })
  .strict();
