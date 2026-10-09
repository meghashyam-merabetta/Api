import bcrypt from 'bcryptjs';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';

const required = ['ADMIN_NAME', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const normalizeEmail = (value) => value.trim().toLowerCase();

try {
  const result = await sequelize.transaction(async (transaction) => {
    const email = normalizeEmail(process.env.ADMIN_EMAIL);
    const existing = await models.user.unscoped().findOne({
      where: { email, realm: 'admin' },
      transaction,
    });
    if (existing) throw new Error('Admin with this email already exists');

    const user = await models.user.create(
      {
        realm: 'admin',
        name: process.env.ADMIN_NAME.trim(),
        email,
        passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
        active: true,
      },
      { transaction },
    );

    const profile = await models.adminProfile.create(
      {
        userId: user.id,
        city: process.env.ADMIN_CITY?.trim() || null,
        pincode: process.env.ADMIN_PINCODE?.trim() || null,
        state: process.env.ADMIN_STATE?.trim() || null,
        requireSuperAdminApproval: false,
        permissions: ['admin.manage'],
      },
      { transaction },
    );

    return { user, profile };
  });

  console.log(`Admin created: ${result.user.email}`);
} finally {
  await sequelize.close();
}
