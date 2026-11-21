import { Op, Transaction } from 'sequelize';
import { HttpError } from '../../shared/errors.js';

const plain = (row) => row.toJSON();
const combination = (attributes) =>
  JSON.stringify(
    Object.keys(attributes)
      .sort()
      .map((key) => [key, attributes[key]]),
  );

function databaseError(error) {
  const code = error.parent?.code ?? error.original?.code;
  if (code === '23505' || error.name === 'SequelizeUniqueConstraintError')
    return new HttpError(
      409,
      'Product code, slug, SKU, or variant combination already exists',
    );
  if (code === '23503') return new HttpError(422, 'Referenced record does not exist');
  if (code === '23502' || code === '23514')
    return new HttpError(
      422,
      'A required value is missing or violates a database constraint',
    );
  if (code === '40001' || code === '40P01')
    return new HttpError(409, 'Concurrent product update; retry the request');
  return error;
}

// Dependencies are injected to test the real handlers without loading config,
// opening a database connection, or importing the application entry point.
export function createVariableProductHandlers({
  sequelize,
  Product,
  ProductVariant,
  VariantAttribute,
  productValues,
  saveDetails,
  getFullProduct,
  validateReferences,
  audit,
}) {
  async function transaction(work, readOnly = false) {
    try {
      return await sequelize.transaction(
        {
          isolationLevel: readOnly
            ? Transaction.ISOLATION_LEVELS.REPEATABLE_READ
            : Transaction.ISOLATION_LEVELS.READ_COMMITTED,
          readOnly,
        },
        async (tx) => {
          // Sequelize 6's readOnly option selects a connection; PostgreSQL also
          // needs this statement to enforce a read-only transaction itself.
          if (readOnly)
            await sequelize.query('SET TRANSACTION READ ONLY', { transaction: tx });
          // Phase 2's indexes have not been inspected against a live database.
          // Serialize variant writers even without a unique SKU/JSONB index.
          // This is a transactional table lock, not DDL or a schema change.
          if (!readOnly)
            await sequelize.query(
              'LOCK TABLE public.product_variants IN SHARE ROW EXCLUSIVE MODE',
              { transaction: tx },
            );
          return work(tx);
        },
      );
    } catch (error) {
      throw databaseError(error);
    }
  }

  async function findParent(id, tx, lock = false) {
    const row = await Product.findOne({
      where: { id, [Op.or]: [{ is_deleted: false }, { is_deleted: null }] },
      transaction: tx,
      ...(lock ? { lock: tx.LOCK.UPDATE } : {}),
    });
    if (!row) throw new HttpError(404, 'Product not found');
    if (row.product_type !== 'variable')
      throw new HttpError(409, 'This endpoint only supports existing variable products');
    return row;
  }

  const findVariants = (id, tx) =>
    ProductVariant.findAll({
      where: { product_id: id },
      paranoid: false,
      order: [['id', 'ASC']],
      transaction: tx,
    });

  async function response(id, tx) {
    const product = await getFullProduct(id, tx);
    const variants = await findVariants(id, tx);
    return {
      ...product,
      id: String(product.id),
      variants: variants.map((row) => {
        const value = plain(row);
        return { ...value, id: String(value.id), product_id: String(value.product_id) };
      }),
    };
  }

  async function validateVariants(changes, existing, tx) {
    const byId = new Map(existing.map((row) => [String(row.id), row]));
    const changedIds = new Set();
    const planned = [];
    for (const input of changes) {
      const previous = input.id ? byId.get(String(input.id)) : undefined;
      if (input.id && !previous)
        throw new HttpError(422, 'Variant ID does not belong to this product');
      if (previous?.deleted_at)
        throw new HttpError(409, 'Deleted variants cannot be edited or restored here');
      if (input.id && changedIds.has(String(input.id)))
        throw new HttpError(422, 'Variant ID appears more than once');
      if (input.id) changedIds.add(String(input.id));
      const value = { ...(previous ? plain(previous) : {}), ...input };
      if (
        value.regular_price === null ||
        value.regular_price === undefined ||
        (value.sale_price !== null &&
          value.sale_price !== undefined &&
          Number(value.sale_price) > Number(value.regular_price))
      )
        throw new HttpError(
          422,
          'sale_price cannot exceed regular_price; regular_price is required',
        );
      planned.push({ input, previous, value });
    }

    // Check the final collection, including omitted, inactive, and deleted rows.
    const final = [
      ...existing.filter((row) => !changedIds.has(String(row.id))).map(plain),
      ...planned.map(({ value }) => value),
    ];
    const skus = new Set();
    const combinations = new Set();
    for (const value of final) {
      if (skus.has(value.sku)) throw new HttpError(409, 'Duplicate variant SKU');
      const key = combination(value.attributes);
      if (combinations.has(key))
        throw new HttpError(409, 'Duplicate variant attribute combination');
      skus.add(value.sku);
      combinations.add(key);
    }

    if (planned.length) {
      const occupied = await ProductVariant.findAll({
        where: { sku: { [Op.in]: planned.map(({ value }) => value.sku) } },
        paranoid: false,
        transaction: tx,
      });
      for (const { value } of planned)
        if (
          occupied.some(
            (row) => row.sku === value.sku && String(row.id) !== String(value.id),
          )
        )
          throw new HttpError(409, 'Variant SKU already in use');
    }

    const attributesToValidate = planned.filter(
      ({ input, previous, value }) =>
        !previous ||
        (input.attributes &&
          combination(value.attributes) !== combination(previous.attributes)),
    );
    const names = [
      ...new Set(
        attributesToValidate.flatMap(({ value }) => Object.keys(value.attributes)),
      ),
    ];
    if (names.length) {
      const definitions = await VariantAttribute.findAll({
        where: { name: { [Op.in]: names } },
        order: [['id', 'ASC']],
        transaction: tx,
        lock: tx.LOCK.SHARE,
      });
      const allowed = new Map(definitions.map((row) => [row.name, row.values]));
      for (const { value } of attributesToValidate)
        for (const [name, option] of Object.entries(value.attributes))
          if (!allowed.get(name)?.includes(option))
            throw new HttpError(
              422,
              'Unknown variant attribute or option; use the variant attribute master',
            );
    }
    return planned;
  }

  async function persistVariants(id, planned, tx) {
    for (const { input, previous } of planned) {
      // Never allow a request to reassign an ID, parent, or deletion timestamp.
      const values = { ...input };
      delete values.id;
      if (previous) {
        if (Object.keys(values).length)
          await previous.update(values, { transaction: tx });
      } else {
        await ProductVariant.create({ ...values, product_id: id }, { transaction: tx });
      }
    }
  }

  return {
    async create(req, res) {
      const { variants, ...input } = req.validated;
      const result = await transaction(async (tx) => {
        const values = {
          ...productValues(input),
          product_type: 'variable',
          stock_quantity: 0,
        };
        await validateReferences(values, tx);
        const planned = await validateVariants(variants, [], tx);
        const parent = await Product.create(values, { transaction: tx });
        await saveDetails(parent.id, input, tx);
        await persistVariants(parent.id, planned, tx);
        const data = await response(parent.id, tx);
        await audit(req, 'product', parent.id, null, data, tx);
        return data;
      });
      res.location(`/api/admin/variable-products/${result.id}`);
      res.status(201).json({ data: result });
    },

    async get(req, res) {
      const result = await transaction(async (tx) => {
        await findParent(req.validatedParams.id, tx);
        return response(req.validatedParams.id, tx);
      }, true);
      res.json({ data: result });
    },

    async update(req, res) {
      const { id } = req.validatedParams;
      const { variants = [], ...input } = req.validated;
      const result = await transaction(async (tx) => {
        const parent = await findParent(id, tx, true);
        const before = await response(id, tx);
        const values = productValues(input, plain(parent));
        await validateReferences({ ...plain(parent), ...values }, tx);
        const existing = await findVariants(id, tx);
        const planned = await validateVariants(variants, existing, tx);
        // Touch the parent for variant-only edits as well.
        await parent.update({ ...values, updated_at: new Date() }, { transaction: tx });
        await saveDetails(id, input, tx);
        await persistVariants(id, planned, tx);
        const data = await response(id, tx);
        await audit(req, 'product', id, before, data, tx);
        return data;
      });
      res.json({ data: result });
    },
  };
}
