import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';

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

  profile.permissions = ['admin.manage'];
  await profile.save();
  console.log(`Granted admin.manage to ${user.email}`);
} finally {
  await sequelize.close();
}
