import { models } from '../models/index.js';
import { HttpError } from './errors.js';

export async function devAdminAuth(req, res, next) {
  const user = await models.user.unscoped().findOne({
    where: {
      email: 'admin@example.com',
      realm: 'admin',
      active: true,
    },
  });

  if (!user) {
    throw new HttpError(
      401,
      'Development admin user not found in database',
    );
  }

  req.auth = {
    realm: 'admin',
    userId: user.id,
    sessionId: null,
  };

  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
  };

  next();
}