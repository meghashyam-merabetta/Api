import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import {
  ADMIN_PERMISSIONS,
  DEFAULT_CMS_ADMIN_PERMISSIONS,
} from '../src/admin/permissions.js';

if (!process.env.ADMIN_EMAIL) throw new Error('ADMIN_EMAIL is required');

try {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const user = await models.user.unscoped().findOne({
    where: { email, realm: 'admin' },
  });
  if (!user) throw new Error('Admin not found');

  const [profile] = await models.adminProfile.findOrCreate({
    where: { userId: user.id },
    defaults: { permissions: [] },
  });

  profile.permissions = [
    ...new Set([
      ...(Array.isArray(profile.permissions) ? profile.permissions : []),
      ADMIN_PERMISSIONS.manage,
      ...DEFAULT_CMS_ADMIN_PERMISSIONS,
    ]),
  ];
  await profile.save();
  console.log(`Granted CMS admin permissions to ${user.email}`);
} finally {
  await sequelize.close();
}
