import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

const columns = 'code, scope, percent, max_discount_paise, active, starts_at, ends_at';

async function findCoupon(code, transaction, lock = false) {
  const rows = await sequelize.query(
    `SELECT ${columns} FROM coupons WHERE code = :code${lock ? ' FOR UPDATE' : ''}`,
    { replacements: { code }, type: QueryTypes.SELECT, transaction },
  );
  if (!rows[0]) throw new HttpError(404, 'Coupon not found');
  return rows[0];
}

export async function listCoupons(req, res) {
  const { limit, offset, scope, active, state, search } = req.validatedQuery;
  const where = [];
  const replacements = { limit, offset };
  if (scope) {
    where.push('scope = :scope');
    replacements.scope = scope;
  }
  if (active !== undefined) {
    where.push('active = :active');
    replacements.active = active === 'true';
  }
  if (search) {
    where.push('code ILIKE :search');
    replacements.search = `%${search}%`;
  }
  if (state === 'scheduled') where.push('starts_at > now()');
  if (state === 'current')
    where.push('starts_at <= now() AND (ends_at IS NULL OR ends_at > now())');
  if (state === 'expired') where.push('ends_at IS NOT NULL AND ends_at <= now()');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [data, count] = await Promise.all([
    sequelize.query(
      `SELECT ${columns} FROM coupons ${clause} ORDER BY code ASC LIMIT :limit OFFSET :offset`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query(`SELECT count(*)::integer AS total FROM coupons ${clause}`, {
      replacements,
      type: QueryTypes.SELECT,
    }),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    data,
    pagination: {
      total: count[0].total,
      limit,
      offset,
      hasMore: offset + data.length < count[0].total,
    },
  });
}

export async function getCoupon(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ data: await findCoupon(req.validatedParams.code) });
}

export async function createCoupon(req, res) {
  const values = req.validated;
  const keys = Object.keys(values);
  const replacements = Object.fromEntries(
    keys.map((key, index) => [`value${index}`, values[key]]),
  );
  try {
    const result = await sequelize.query(
      `INSERT INTO coupons (${keys.map((key) => `"${key}"`).join(', ')})
       VALUES (${keys.map((_key, index) => `:value${index}`).join(', ')}) RETURNING ${columns}`,
      { replacements, type: QueryTypes.INSERT },
    );
    res.status(201).json({ data: result[0][0] });
  } catch (error) {
    if (error?.original?.code === '23505')
      throw new HttpError(409, 'Coupon code already exists');
    throw error;
  }
}

export async function updateCoupon(req, res) {
  const row = await sequelize.transaction(async (transaction) => {
    const current = await findCoupon(req.validatedParams.code, transaction, true);
    const starts = req.validated.starts_at ?? current.starts_at;
    const ends = Object.hasOwn(req.validated, 'ends_at')
      ? req.validated.ends_at
      : current.ends_at;
    if (ends && new Date(ends) <= new Date(starts))
      throw new HttpError(422, 'ends_at must be after starts_at');
    const keys = Object.keys(req.validated);
    const replacements = Object.fromEntries(
      keys.map((key, index) => [`value${index}`, req.validated[key]]),
    );
    const result = await sequelize.query(
      `UPDATE coupons SET ${keys.map((key, index) => `"${key}" = :value${index}`).join(', ')}
       WHERE code = :code RETURNING ${columns}`,
      {
        replacements: { ...replacements, code: current.code },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );
    return result[0][0];
  });
  res.json({ data: row });
}

export async function deleteCoupon(req, res) {
  await sequelize.transaction(async (transaction) => {
    const current = await findCoupon(req.validatedParams.code, transaction, true);
    await sequelize.query('DELETE FROM coupons WHERE code = :code', {
      replacements: { code: current.code },
      type: QueryTypes.DELETE,
      transaction,
    });
  });
  res.status(204).end();
}
