import { z } from 'zod';
import { email, password } from '../../shared/schema.js';
export const loginSchema = z.object({ email, password }).strict();
