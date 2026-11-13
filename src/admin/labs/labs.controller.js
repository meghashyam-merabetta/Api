import { Op, QueryTypes, UniqueConstraintError } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { createEntityImageControllers } from '../../shared/entity-image.controller.js';

const attributes = [
  'id',
  'name',
  'description',
  'rating',
  'image',
  'color',
  'bg',
  'active',
  'city',
  'homeCollection',
  'createdAt',
  'updatedAt',
];

async function findLab(id, transaction, lock = false) {
  const lab = await models.lab.findByPk(id, {
    attributes,
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!lab) throw new HttpError(404, 'Lab not found');
  return lab;
}

export const { getImage: getLabImage, uploadImage: uploadLabImage } =
  createEntityImageControllers({
    model: models.lab,
    resource: 'labs',
    idParam: 'labId',
    idField: 'id',
    imageField: 'image',
    responseField: 'image',
    label: 'Lab',
  });

export async function listLabs(req, res) {
  const { limit, offset, search, city, active, homeCollection, sort_by, sort_order } =
    req.validatedQuery;
  const where = {};
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    where[Op.or] = [
      { id: { [Op.iLike]: pattern } },
      { name: { [Op.iLike]: pattern } },
      { city: { [Op.iLike]: pattern } },
    ];
  }
  if (city) where.city = city;
  if (active !== undefined) where.active = active === 'true';
  if (homeCollection !== undefined) where.homeCollection = homeCollection === 'true';

  const { rows, count } = await models.lab.findAndCountAll({
    where,
    attributes,
    order: [
      [sort_by, sort_order.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit,
    offset,
  });
  res.set('Cache-Control', 'no-store');
  res.json({
    data: rows,
    pagination: {
      total: count,
      limit,
      offset,
      hasMore: offset + rows.length < count,
    },
  });
}

export async function getLab(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ data: await findLab(req.validatedParams.labId) });
}

export async function createLab(req, res) {
  try {
    const lab = await models.lab.create(req.validated);
    res.status(201).json({ data: lab });
  } catch (error) {
    if (error instanceof UniqueConstraintError || error?.original?.code === '23505')
      throw new HttpError(409, 'Lab ID already exists');
    throw error;
  }
}

export async function updateLab(req, res) {
  const lab = await sequelize.transaction(async (transaction) => {
    const current = await findLab(req.validatedParams.labId, transaction, true);
    return current.update(req.validated, { transaction });
  });
  res.json({ data: lab });
}

async function dependencyCounts(labId, transaction) {
  const rows = await sequelize.query(
    `SELECT
       (SELECT count(*)::integer FROM lab_packages WHERE lab_id = :labId) AS packages,
       (SELECT count(*)::integer FROM lab_bookings WHERE lab_id = :labId) AS bookings,
       (SELECT count(*)::integer FROM lab_catalog_sync WHERE lab_id = :labId) AS catalog_sync,
       (SELECT count(*)::integer FROM lab_service_areas WHERE lab_ids ? :labId) AS service_areas`,
    { replacements: { labId }, type: QueryTypes.SELECT, transaction },
  );
  return rows[0];
}

export async function deleteLab(req, res) {
  await sequelize.transaction(async (transaction) => {
    const lab = await findLab(req.validatedParams.labId, transaction, true);
    if (lab.id === 'redcliffe')
      throw new HttpError(
        409,
        'The Redcliffe integration lab cannot be deleted; deactivate it instead',
      );
    const dependencies = await dependencyCounts(lab.id, transaction);
    if (Object.values(dependencies).some((count) => Number(count) > 0)) {
      throw new HttpError(
        409,
        'Cannot delete a lab referenced by packages, bookings, catalog sync, or service areas; deactivate it instead',
      );
    }
    await lab.destroy({ transaction });
  });
  res.status(204).end();
}
