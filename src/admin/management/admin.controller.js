import bcrypt from 'bcryptjs';
import { models } from '../../models/index.js';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

const PERMISSIONS = Object.freeze({
  read: 'admins.read',
  create: 'admins.create',
  update: 'admins.update',
  delete: 'admins.delete',
  password: 'admins.password',
  manage: 'admin.manage',
  wildcard: '*',
});

function hasPermission(profile, permission) {
  const permissions = Array.isArray(profile?.permissions) ? profile.permissions : [];
  return (
    permissions.includes(PERMISSIONS.wildcard) ||
    permissions.includes(PERMISSIONS.manage) ||
    permissions.includes(permission)
  );
}

function requirePermission(req, profile, permission) {
  if (!hasPermission(profile, permission)) {
    throw new HttpError(403, 'Insufficient admin permission');
  }
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function serializeAdmin(user, profile) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    active: user.active,
    city: profile?.city ?? null,
    pincode: profile?.pincode ?? null,
    state: profile?.state ?? null,
    adminApproval: {
      requireSuperAdminApproval: profile?.requireSuperAdminApproval ?? false,
    },
    permissions: Array.isArray(profile?.permissions) ? profile.permissions : [],
    createdAt: profile?.createdAt ?? null,
    updatedAt: profile?.updatedAt ?? null,
  };
}

async function getProfileByUserId(userId, transaction) {
  return models.adminProfile.findOne({ where: { userId }, transaction });
}

async function getAdminRecord(id, transaction) {
  const user = await models.user.unscoped().findOne({
    where: { id, realm: 'admin' },
    transaction,
  });
  if (!user) throw new HttpError(404, 'Admin not found');

  const profile = await getProfileByUserId(user.id, transaction);
  if (!profile) throw new HttpError(500, 'Admin profile is missing');

  return { user, profile };
}

async function assertEmailAvailable(email, excludeId, transaction) {
  const existing = await models.user.unscoped().findOne({
    where: { email: normalizeEmail(email), realm: 'admin' },
    transaction,
  });

  if (existing && existing.id !== excludeId) {
    throw new HttpError(409, 'Admin already exists');
  }
}

export async function listAdmins(req, res) {
  const { limit } = req.validatedQuery;
  const currentProfile = await getProfileByUserId(req.auth.userId);

  let users;
  if (hasPermission(currentProfile, PERMISSIONS.read)) {
    users = await models.user.unscoped().findAll({
      where: { realm: 'admin' },
      order: [['name', 'ASC']],
      limit,
    });
  } else {
    users = await models.user.unscoped().findAll({
      where: { id: req.auth.userId, realm: 'admin' },
      limit: 1,
    });
  }

  const ids = users.map((user) => user.id);
  const profiles = ids.length
    ? await models.adminProfile.findAll({ where: { userId: ids } })
    : [];
  const byUserId = new Map(profiles.map((profile) => [profile.userId, profile]));

  res.json({ data: users.map((user) => serializeAdmin(user, byUserId.get(user.id))) });
}

export async function getAdmin(req, res) {
  const { id } = req.validatedParams;
  const { user, profile } = await getAdminRecord(id);

  if (id !== req.auth.userId) {
    requirePermission(req, await getProfileByUserId(req.auth.userId), PERMISSIONS.read);
  }

  res.json({ data: serializeAdmin(user, profile) });
}

export async function createAdmin(req, res) {
  const data = req.validated;

  const currentProfile = await getProfileByUserId(req.auth.userId);
  requirePermission(req, currentProfile, PERMISSIONS.create);

  if (data.permissions.length || data.adminApproval.requireSuperAdminApproval) {
    requirePermission(req, currentProfile, PERMISSIONS.manage);
  }

  const admin = await sequelize.transaction(async (transaction) => {
    await assertEmailAvailable(data.email, null, transaction);

    const user = await models.user.create(
      {
        realm: 'admin',
        name: data.name,
        email: normalizeEmail(data.email),
        passwordHash: await bcrypt.hash(data.password, 12),
        active: true,
      },
      { transaction },
    );

    const profile = await models.adminProfile.create(
      {
        userId: user.id,
        city: data.city,
        pincode: data.pincode,
        state: data.state,
        requireSuperAdminApproval: data.adminApproval.requireSuperAdminApproval,
        permissions: data.permissions,
      },
      { transaction },
    );

    return { user, profile };
  });

  res.status(201).json({ data: serializeAdmin(admin.user, admin.profile) });
}

export async function updateAdmin(req, res) {
  const { id } = req.validatedParams;
  const data = req.validated;
  const currentProfile = await getProfileByUserId(req.auth.userId);
  const isSelf = id === req.auth.userId;

  if (!isSelf) requirePermission(req, currentProfile, PERMISSIONS.update);
  if (data.permissions !== undefined || data.adminApproval !== undefined) {
    requirePermission(req, currentProfile, PERMISSIONS.manage);
  }

  const admin = await sequelize.transaction(async (transaction) => {
    const record = await getAdminRecord(id, transaction);

    if (data.email !== undefined) {
      await assertEmailAvailable(data.email, id, transaction);
      record.user.email = normalizeEmail(data.email);
    }
    if (data.name !== undefined) record.user.name = data.name;

    await record.user.save({ transaction });

    if (data.city !== undefined) record.profile.city = data.city;
    if (data.pincode !== undefined) record.profile.pincode = data.pincode;
    if (data.state !== undefined) record.profile.state = data.state;
    if (data.permissions !== undefined) record.profile.permissions = data.permissions;
    if (data.adminApproval !== undefined) {
      record.profile.requireSuperAdminApproval =
        data.adminApproval.requireSuperAdminApproval;
    }

    await record.profile.save({ transaction });
    return record;
  });

  res.json({ data: serializeAdmin(admin.user, admin.profile) });
}

export async function deleteAdmin(req, res) {
  const { id } = req.validatedParams;
  const currentProfile = await getProfileByUserId(req.auth.userId);
  requirePermission(req, currentProfile, PERMISSIONS.delete);

  if (id === req.auth.userId) {
    throw new HttpError(400, 'An admin cannot deactivate their own account');
  }

  await sequelize.transaction(async (transaction) => {
    const { user } = await getAdminRecord(id, transaction);
    user.active = false;
    await user.save({ transaction });
    await models.session.destroy({
      where: { userId: user.id, realm: 'admin' },
      transaction,
    });
  });

  res.status(204).end();
}

export async function changeAdminPassword(req, res) {
  const { id } = req.validatedParams;
  const { currentPassword, newPassword } = req.validated;
  const isSelf = id === req.auth.userId;
  const currentProfile = await getProfileByUserId(req.auth.userId);

  if (!isSelf) requirePermission(req, currentProfile, PERMISSIONS.password);

  await sequelize.transaction(async (transaction) => {
    const { user } = await getAdminRecord(id, transaction);

    if (isSelf) {
      if (!currentPassword) {
        throw new HttpError(400, 'Current password is required');
      }
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) throw new HttpError(401, 'Current password is incorrect');
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await user.save({ transaction });

    await models.session.destroy({
      where: { userId: user.id, realm: 'admin' },
      transaction,
    });
  });

  res.json({ message: 'Admin password changed successfully' });
}
