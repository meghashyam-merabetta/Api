import { catalogMutation, sendMutation } from '../../shared/catalog-idempotency.js';
import { publishProductCatalog } from '../../shared/catalog-publisher.js';
import { normalizePricing } from '../../shared/catalog-fields.js';
import { Op } from 'sequelize';
import {
  Product,
  ProductVariant,
  VariantAttribute,
  ProductCatalog,
} from '../../models/index.js';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
async function findAttribute(id, transaction) {
  const row = await VariantAttribute.findByPk(id, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!row) throw new HttpError(404, 'Variant attribute not found');
  return row;
}
async function attributeInUse(name, transaction) {
  const [rows] = await sequelize.query(
    'SELECT 1 FROM product_variants WHERE attributes ? :name LIMIT 1',
    { replacements: { name }, transaction },
  );
  return rows.length > 0;
}
async function product(id, transaction) {
  const row = await Product.findByPk(id, {
    transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!row) throw new HttpError(404, 'Product not found');
  return row;
}
export async function saveVariant(req, res) {
  const { productId, variantId } = req.validatedParams;
  const result = await catalogMutation(
    req,
    req.validated,
    variantId ? 200 : 201,
    async (transaction) => {
      await product(productId, transaction);
      let existing = variantId
        ? await ProductVariant.findOne({
            where: { id: variantId, product_id: productId },
            transaction,
          })
        : null;
      if (variantId && !existing) throw new HttpError(404, 'Product variant not found');
      if (!existing && req.validated.attributes) {
        existing = await ProductVariant.findOne({
          where: {
            product_id: productId,
            attributes: { [Op.eq]: req.validated.attributes },
          },
          transaction,
        });
      }
      const data = normalizePricing(req.validated, existing?.toJSON());
      if (data.attributes) {
        const definitions = await VariantAttribute.findAll({
          where: { name: { [Op.in]: Object.keys(data.attributes) } },
          order: [['id', 'ASC']],
          transaction,
          lock: transaction.LOCK.SHARE,
        });
        if (
          definitions.length !== Object.keys(data.attributes).length ||
          definitions.some((def) => !def.values.includes(data.attributes[def.name]))
        )
          throw new HttpError(400, 'Unknown variant attribute or option');
      }
      const duplicate = await ProductVariant.findOne({
        where: {
          product_id: productId,
          attributes: { [Op.eq]: data.attributes ?? existing.attributes },
          ...(existing ? { id: { [Op.ne]: existing.id } } : {}),
        },
        transaction,
      });
      if (duplicate)
        throw new HttpError(409, 'This variant attribute combination already exists');
      const row = existing
        ? await existing.update(data, { transaction })
        : await ProductVariant.create(
            { ...data, product_id: productId },
            { transaction },
          );
      await publishProductCatalog(productId, transaction);
      return row;
    },
  );
  sendMutation(res, result);
}
async function modelsCatalogDeactivate(variantId, transaction) {
  await ProductCatalog.update(
    { active: false },
    { where: { id: `variant:${variantId}` }, transaction },
  );
}
export async function listVariantAttributes(req, res) {
  const { limit, offset } = req.validatedQuery;
  const { rows, count } = await VariantAttribute.findAndCountAll({
    limit,
    offset,
    order: [
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
  });
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
export async function createVariantAttribute(req, res) {
  return res.status(201).json({ data: await VariantAttribute.create(req.validated) });
}
export async function updateVariantAttribute(req, res) {
  const result = await sequelize.transaction(async (transaction) => {
    const row = await findAttribute(req.validatedParams.attributeId, transaction);
    // Preserve the meaning of existing variant selections.
    const removesValues =
      req.validated.values &&
      row.values.some((value) => !req.validated.values.includes(value));
    if (
      ((req.validated.name && req.validated.name !== row.name) || removesValues) &&
      (await attributeInUse(row.name, transaction))
    )
      throw new HttpError(
        409,
        'Cannot rename or remove options from an attribute in use',
      );
    return row.update(req.validated, { transaction });
  });
  res.json({ data: result });
}
export async function deleteVariantAttribute(req, res) {
  await sequelize.transaction(async (transaction) => {
    const row = await findAttribute(req.validatedParams.attributeId, transaction);
    if (await attributeInUse(row.name, transaction))
      throw new HttpError(409, 'Cannot delete an attribute in use');
    await row.destroy({ transaction });
  });
  res.status(204).end();
}
export async function getProductVariant(req, res) {
  await product(req.validatedParams.productId);
  const row = await ProductVariant.findOne({
    where: {
      id: req.validatedParams.variantId,
      product_id: req.validatedParams.productId,
    },
  });
  if (!row) throw new HttpError(404, 'Product variant not found');
  res.json({ data: row });
}
export async function listProductVariants(req, res) {
  await product(req.validatedParams.productId);
  const { limit, offset } = req.validatedQuery;
  const { rows, count } = await ProductVariant.findAndCountAll({
    where: { product_id: req.validatedParams.productId },
    limit,
    offset,
    order: [
      ['sku', 'ASC'],
      ['id', 'ASC'],
    ],
  });
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
export async function deleteProductVariant(req, res) {
  await sequelize.transaction(async (transaction) => {
    await product(req.validatedParams.productId, transaction);
    const removed = await ProductVariant.destroy({
      where: {
        id: req.validatedParams.variantId,
        product_id: req.validatedParams.productId,
      },
      transaction,
    });
    if (!removed) throw new HttpError(404, 'Product variant not found');
    await modelsCatalogDeactivate(req.validatedParams.variantId, transaction);
    await publishProductCatalog(req.validatedParams.productId, transaction);
  });
  res.status(204).end();
}
