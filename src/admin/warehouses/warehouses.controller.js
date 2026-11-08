
import { QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

// Matches the new public.warehouses table.
// Primary key: id (BIGINT).

const WRITABLE_COLUMNS = new Set([
  'warehouse_code',
  'warehouse_name',
  'warehouse_type',
  'contact_person',
  'contact_number',
  'email',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'country',
  'pincode',
  'is_active',
]);

const SELECT_COLUMNS = `
  id::text AS id,
  warehouse_code,
  warehouse_name,
  warehouse_type,
  contact_person,
  contact_number,
  email,
  address_line1,
  address_line2,
  city,
  state,
  country,
  pincode,
  is_active,
  created_at,
  updated_at
`;

function sqlOptions(replacements = {}, transaction) {
  return {
    type: QueryTypes.SELECT,
    replacements,
    transaction,
  };
}

async function rows(sql, replacements = {}, transaction) {
  return sequelize.query(sql, sqlOptions(replacements, transaction));
}

function mapDbError(error) {
  const code = error?.parent?.code ?? error?.original?.code;

  if (code === '23505') {
    return new HttpError(409, 'Warehouse code already exists');
  }

  if (code === '23503') {
    return new HttpError(
      409,
      'Warehouse is referenced by another record',
    );
  }

  if (code === '23502') {
    return new HttpError(422, 'Required warehouse field is missing');
  }

  if (['23514', '22001', '22P02'].includes(code)) {
    return new HttpError(422, 'Invalid warehouse field value');
  }

  return error;
}

function writableEntries(body) {
  return Object.entries(body).filter(([column]) =>
    WRITABLE_COLUMNS.has(column),
  );
}

async function requireNoInventory(id, transaction) {
  const [inventory] = await rows(
    `SELECT COUNT(*)::int AS total
     FROM public.product_inventory
     WHERE warehouse_id = :id`,
    { id },
    transaction,
  );

  if (inventory.total > 0) {
    throw new HttpError(
      409,
      'Warehouse has inventory records; move or reconcile them before deleting it',
    );
  }
}

// =====================================================
// GET /api/admin/warehouses
// =====================================================

export async function listWarehouses(req, res) {
  const { limit, offset, search, is_active, active } =
    req.validatedQuery;

  const conditions = [];
  const parameters = { limit, offset };

  if (search) {
    conditions.push(`
      (
        warehouse_code ILIKE :search OR
        warehouse_name ILIKE :search OR
        COALESCE(city, '') ILIKE :search OR
        COALESCE(contact_person, '') ILIKE :search
      )
    `);

    parameters.search = `%${search}%`;
  }

  const activeFilter = is_active ?? active;

  if (activeFilter !== undefined) {
    conditions.push('is_active = :isActive');
    parameters.isActive = activeFilter === 'true';
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const result = await sequelize.transaction(
    {
      isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
    },
    async (transaction) => {
      const [count] = await rows(
        `
        SELECT COUNT(*)::int AS total
        FROM public.warehouses
        ${where}
        `,
        parameters,
        transaction,
      );

      const data = await rows(
        `
        SELECT ${SELECT_COLUMNS}
        FROM public.warehouses
        ${where}
        ORDER BY id ASC
        LIMIT :limit OFFSET :offset
        `,
        parameters,
        transaction,
      );

      return {
        total: count.total,
        data,
      };
    },
  );

  res.json({
    data: result.data,
    pagination: {
      total: result.total,
      limit,
      offset,
      hasMore: offset + result.data.length < result.total,
    },
  });
}

// =====================================================
// GET /api/admin/warehouses/:warehouseId
// =====================================================

export async function getWarehouse(req, res) {
  const [data] = await rows(
    `
    SELECT ${SELECT_COLUMNS}
    FROM public.warehouses
    WHERE id = :id
    `,
    {
      id: req.validatedParams.warehouseId,
    },
  );

  if (!data) {
    throw new HttpError(404, 'Warehouse not found');
  }

  res.json({ data });
}

// =====================================================
// POST /api/admin/warehouses
// =====================================================

export async function createWarehouse(req, res) {
  const fields = writableEntries(req.validated);

  const columns = fields.map(([column]) => column);

  const replacements = Object.fromEntries(fields);

  try {
    const [data] = await rows(
      `
      INSERT INTO public.warehouses (
        ${columns.join(', ')}
      )
      VALUES (
        ${columns.map((column) => `:${column}`).join(', ')}
      )
      RETURNING ${SELECT_COLUMNS}
      `,
      replacements,
    );

    res
      .status(201)
      .location(`/api/admin/warehouses/${data.id}`)
      .json({ data });
  } catch (error) {
    throw mapDbError(error);
  }
}

// =====================================================
// PATCH /api/admin/warehouses/:warehouseId
// =====================================================

export async function updateWarehouse(req, res) {
  const fields = writableEntries(req.validated);

  if (!fields.length) {
    throw new HttpError(
      422,
      'Provide at least one field to update',
    );
  }

  const updates = fields.map(
    ([column]) => `${column} = :${column}`,
  );

  const replacements = {
    ...Object.fromEntries(fields),
    id: req.validatedParams.warehouseId,
  };

  try {
    const data = await sequelize.transaction(
      async (transaction) => {
        if (req.validated.is_active === false) {
          const [warehouse] = await rows(
            `
            SELECT id
            FROM public.warehouses
            WHERE id = :id
            FOR UPDATE
            `,
            { id: replacements.id },
            transaction,
          );

          if (!warehouse) {
            throw new HttpError(404, 'Warehouse not found');
          }

          await requireNoInventory(
            replacements.id,
            transaction,
          );
        }

        const [updated] = await rows(
          `
          UPDATE public.warehouses
          SET
            ${updates.join(', ')},
            updated_at = CURRENT_TIMESTAMP
          WHERE id = :id
          RETURNING ${SELECT_COLUMNS}
          `,
          replacements,
          transaction,
        );

        return updated;
      },
    );

    if (!data) {
      throw new HttpError(404, 'Warehouse not found');
    }

    res.json({ data });
  } catch (error) {
    throw mapDbError(error);
  }
}

// =====================================================
// DELETE /api/admin/warehouses/:warehouseId
// =====================================================

// Safe deactivation instead of permanent deletion.
// Existing inventory must be reconciled first.

export async function deleteWarehouse(req, res) {
  const id = req.validatedParams.warehouseId;

  await sequelize.transaction(async (transaction) => {
    const [warehouse] = await rows(
      `
      SELECT id
      FROM public.warehouses
      WHERE id = :id
      FOR UPDATE
      `,
      { id },
      transaction,
    );

    if (!warehouse) {
      throw new HttpError(404, 'Warehouse not found');
    }

    await requireNoInventory(id, transaction);

    await rows(
      `
      UPDATE public.warehouses
      SET
        is_active = false,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = :id
      RETURNING id
      `,
      { id },
      transaction,
    );
  });

  res.status(204).end();
}
