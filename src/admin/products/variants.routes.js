import { catalogMutation, sendMutation } from './idempotency.js';
import { publishProductCatalog } from './catalog-publisher.js';
import { z } from 'zod';
import { Op } from 'sequelize';
import {
  Product,
  ProductVariant,
  VariantAttribute,
  ProductCatalog,
} from '../../models/index.js';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import { normalizePricing, catalogFields } from './catalog-fields.js';
const token = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !value.includes(','), 'Each option must be a separate value');
const attribute = z
  .object({
    name: token,
    values: z
      .array(token)
      .min(1)
      .max(100)
      .refine(
        (values) => new Set(values).size === values.length,
        'Options must be unique',
      ),
  })
  .strict();
const attributeParams = z
  .object({ attributeId: z.coerce.number().int().positive() })
  .strict();
const productParams = z
  .object({ productId: z.coerce.number().int().positive() })
  .strict();
const variantParams = productParams.extend({
  variantId: z.coerce.number().int().positive(),
});
const pagination = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
const variant = z
  .object({
    sku: z.string().trim().min(1).max(100),
    variant_name: z.string().trim().min(1).max(200).nullable().optional(),
    barcode: z.string().trim().min(1).max(100).nullable().optional(),
    weight_grams: z.number().int().min(0).max(2147483647).nullable().optional(),
    attributes: z
      .record(token, token)
      .refine(
        (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 20,
        'Provide 1–20 attributes',
      ),
    regular_price: catalogFields.regular_price,
    sale_price: catalogFields.sale_price,
    stock_quantity: catalogFields.stock_quantity,
    is_active: z.boolean().optional(),
  })
  .strict();
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
async function saveVariant(req, res) {
  const { productId, variantId } = req.validatedParams;
  const result = await catalogMutation(
    req,
    req.validated,
    variantId ? 200 : 201,
    async (transaction) => {
      const parent = await product(productId, transaction);
      if (parent.product_type !== 'variable')
        throw new HttpError(400, 'Variants require a variable product');
      const existing = variantId
        ? await ProductVariant.findOne({
            where: { id: variantId, product_id: productId },
            transaction,
          })
        : null;
      if (variantId && !existing) throw new HttpError(404, 'Product variant not found');
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
          ...(variantId ? { id: { [Op.ne]: variantId } } : {}),
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
export const variantAttributeRoutes = [
  {
    method: 'get',
    path: '/',
    query: pagination,
    handler: async (req, res) => {
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
    },
  },
  {
    method: 'post',
    path: '/',
    schema: attribute,
    handler: async (req, res) =>
      res.status(201).json({ data: await VariantAttribute.create(req.validated) }),
  },
  {
    method: 'patch',
    path: '/:attributeId',
    params: attributeParams,
    schema: attribute
      .partial()
      .refine((v) => Object.keys(v).length > 0, 'Provide at least one field'),
    handler: async (req, res) => {
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
    },
  },
  {
    method: 'delete',
    path: '/:attributeId',
    params: attributeParams,
    handler: async (req, res) => {
      await sequelize.transaction(async (transaction) => {
        const row = await findAttribute(req.validatedParams.attributeId, transaction);
        if (await attributeInUse(row.name, transaction))
          throw new HttpError(409, 'Cannot delete an attribute in use');
        await row.destroy({ transaction });
      });
      res.status(204).end();
    },
  },
];
export const productVariantRoutes = [
  {
    method: 'get',
    path: '/:productId/variants/:variantId',
    params: variantParams,
    handler: async (req, res) => {
      await product(req.validatedParams.productId);
      const row = await ProductVariant.findOne({
        where: {
          id: req.validatedParams.variantId,
          product_id: req.validatedParams.productId,
        },
      });
      if (!row) throw new HttpError(404, 'Product variant not found');
      res.json({ data: row });
    },
  },
  {
    method: 'get',
    path: '/:productId/variants',
    params: productParams,
    query: pagination,
    handler: async (req, res) => {
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
    },
  },
  {
    method: 'post',
    path: '/:productId/variants',
    params: productParams,
    schema: variant,
    handler: saveVariant,
  },
  {
    method: 'patch',
    path: '/:productId/variants/:variantId',
    params: variantParams,
    schema: variant
      .partial()
      .refine((v) => Object.keys(v).length > 0, 'Provide at least one field'),
    handler: saveVariant,
  },
  {
    method: 'delete',
    path: '/:productId/variants/:variantId',
    params: variantParams,
    handler: async (req, res) => {
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
    },
  },
];

async function modelsCatalogDeactivate(variantId, transaction) {
  await ProductCatalog.update(
    { active: false },
    { where: { id: `variant:${variantId}` }, transaction },
  );
}
