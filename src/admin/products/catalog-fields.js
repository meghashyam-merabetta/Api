import { z } from 'zod';
import { HttpError } from '../../shared/errors.js';

const money = z.number().finite().min(0).max(999999999.99).multipleOf(0.01);
const percent = z.number().finite().min(0).max(100).multipleOf(0.01);
const text = z.string().trim().max(2000).nullable().optional();
export const catalogFields = {
  product_code: z.string().trim().min(1).max(100).nullable().optional(),
  sku: z.string().trim().min(1).max(100).nullable().optional(),
  product_type: z.enum(['simple', 'variable']).optional(),
  regular_price: money.nullable().optional(),
  sale_price: money.nullable().optional(),
  mrp: money.optional(),
  offer_price: money.nullable().optional(),
  offer_percent: percent.nullable().optional(),
  special_discount_enabled: z.boolean().optional(),
  special_discount_percent: percent.optional(),
  festival_offer_enabled: z.boolean().optional(),
  festival_offer_percent: percent.optional(),
  stock_quantity: z.number().int().min(0).optional(),
  min_order_quantity: z.number().int().min(1).optional(),
  max_order_quantity: z.number().int().min(1).nullable().optional(),
  target_audience: text,
  hsn_code: z.string().trim().max(20).nullable().optional(),
  gst_rate: percent.nullable().optional(),
  weight: z.number().finite().positive().nullable().optional(),
  weight_unit: z.enum(['g', 'kg']).optional(),
  unit_count: z.number().int().positive().nullable().optional(),
  package_length: z.number().finite().positive().nullable().optional(),
  package_breadth: z.number().finite().positive().nullable().optional(),
  package_height: z.number().finite().positive().nullable().optional(),
  dimension_unit: z.enum(['cm', 'mm', 'in']).optional(),
  material: text,
  colour: text,
  package_type: text,
  shelf_life: text,
  water_resistant: z.boolean().nullable().optional(),
  hazardous_clause: text,
  manufactured_in: text,
  company_name: text,
  company_address: text,
  packer_name: text,
  packer_address: text,
  keywords: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
};
export const storedCatalogFields = Object.keys(catalogFields).filter(
  (key) => !['mrp', 'offer_price'].includes(key),
);

// Apply to the merged record so PATCH validates relationships against stored values.
export function normalizePricing(input, previous = {}) {
  const data = { ...input };
  for (const [alias, field] of [
    ['mrp', 'regular_price'],
    ['offer_price', 'sale_price'],
  ]) {
    if (Object.hasOwn(data, alias)) {
      if (Object.hasOwn(data, field) && data[field] !== data[alias])
        throw new HttpError(400, `${alias} and ${field} must agree`);
      data[field] = data[alias];
      delete data[alias];
    }
  }
  const merged = { ...previous, ...data };
  if (
    merged.max_order_quantity !== null &&
    merged.max_order_quantity !== undefined &&
    merged.max_order_quantity < (merged.min_order_quantity ?? 1)
  )
    throw new HttpError(400, 'max_order_quantity must be at least min_order_quantity');
  const regular =
    merged.regular_price === null || merged.regular_price === undefined
      ? null
      : Number(merged.regular_price);
  if (merged.offer_percent !== null && merged.offer_percent !== undefined) {
    if (regular === null || regular === undefined)
      throw new HttpError(400, 'regular_price is required for offer_percent');
    data.sale_price = Math.round(regular * (100 - Number(merged.offer_percent))) / 100;
  }
  const sale = Object.hasOwn(data, 'sale_price') ? data.sale_price : merged.sale_price;
  if (
    sale !== null &&
    sale !== undefined &&
    (regular === null || regular === undefined || Number(sale) > regular)
  )
    throw new HttpError(400, 'sale_price requires regular_price and cannot exceed it');
  return data;
}

export function effectivePrice(record) {
  if (record.regular_price === null || record.regular_price === undefined) return null;
  let price = Math.round(Number(record.sale_price ?? record.regular_price) * 100);
  if (record.special_discount_enabled)
    price = Math.round(
      (price * (100 - Number(record.special_discount_percent ?? 0))) / 100,
    );
  if (record.festival_offer_enabled)
    price = Math.round(
      (price * (100 - Number(record.festival_offer_percent ?? 0))) / 100,
    );
  return price / 100;
}
