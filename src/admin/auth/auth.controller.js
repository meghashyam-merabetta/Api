import { models } from '../../models/index.js';
import { createAuth } from '../../shared/auth.js';
export const adminAuth = createAuth('admin', models.user, models.session);
