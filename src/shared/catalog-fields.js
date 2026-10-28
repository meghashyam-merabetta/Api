import { z } from 'zod';
import { HttpError } from './errors.js';

const money = z.number().finite().min(0).max(999999999.99).multipleOf(0.01);
const percent = z.number().finite().min(0).max(100).multipleOf(0.01);
const text = z.string().trim().max(2000).nullable().optional();
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();
export const catalogFields = {
  product_code: z.string().trim().min(1).max(100).nullable().optional(),
  sku: z.string().trim().min(1).max(100).nullable().optional(),
  barcode: z.string().trim().min(1).max(100).nullable().optional(),
  product_type: z.enum(['simple', 'variable']).optional(),
  item_condition: z.enum(['new', 'refurbished']).optional(),
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
  product_length: z.number().finite().positive().nullable().optional(),
  product_breadth: z.number().finite().positive().nullable().optional(),
  product_height: z.number().finite().positive().nullable().optional(),
  product_dimension_unit: z.enum(['cm', 'mm', 'in']).nullable().optional(),
  material: text,
  colour: text,
  package_type: text,
  shelf_life: text,
  reusable: z.boolean().nullable().optional(),
  water_resistant: z.boolean().nullable().optional(),
  has_accessories: z.boolean().optional(),
  accessories: text,
  gift_options_available: z.boolean().optional(),
  gift_options_charge: money.nullable().optional(),
  gift_wrap_available: z.boolean().optional(),
  gift_wrap_charge: money.nullable().optional(),
  hazardous_clause: text,
  manufactured_in: text,
  company_name: text,
  company_address: text,
  packer_name: text,
  packer_address: text,
  manufacturer_sku: text,
  brand_type: z.enum(['company', 'generic']).nullable().optional(),
  is_customisable: z.boolean().nullable().optional(),
  model_number: text,
  manufacturer_contact_name: text,
  manufacturer_phone: text,
  manufacturer_email: z.string().trim().email().max(255).nullable().optional(),
  license_number: text,
  repacker_name: text,
  repacker_address: text,
  age_min: z.number().int().min(0).nullable().optional(),
  age_max: z.number().int().min(0).nullable().optional(),
  age_unit: z.enum(['years', 'months']).nullable().optional(),
  audience_age_group: z
    .enum(['infants', 'children', 'young people', 'adults', 'seniors', 'all ages'])
    .nullable()
    .optional(),
  product_uses: text,
  special_instructions: text,
  material_composition: text,
  material_type: text,
  resistance_level: text,
  heat_resistant: z.boolean().nullable().optional(),
  gas_resistant: z.boolean().nullable().optional(),
  physical_state: z.enum(['solid', 'liquid', 'gas']).nullable().optional(),
  pattern: text,
  hazard_classification: text,
  net_weight: z.number().finite().min(0).nullable().optional(),
  net_weight_unit: z.enum(['g', 'kg']).nullable().optional(),
  manufacturing_date: isoDate,
  fulfillment_channel: z.enum(['merabetta', 'self']).nullable().optional(),
  seller_handling_days: z.number().int().min(0).nullable().optional(),
  business_offer_percent: percent.nullable().optional(),
  sale_start_date: isoDate,
  sale_end_date: isoDate,
  shipping_template: text,
  seller_pincodes: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[1-9]\d{5}$/),
    )
    .nullable()
    .optional(),
  battery_required: z.boolean().nullable().optional(),
  battery_consumption: text,
  cosmetic_features: text,
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

  if (data.has_accessories === false) {
    data.accessories = null;
  } else if (
    !Object.hasOwn(data, 'has_accessories') &&
    Object.hasOwn(data, 'accessories') &&
    typeof data.accessories === 'string' &&
    data.accessories.trim().length > 0
  ) {
    data.has_accessories = true;
  }
  const hasAccessories = Object.hasOwn(data, 'has_accessories')
    ? data.has_accessories
    : Boolean(merged.has_accessories);
  const accessoriesText = Object.hasOwn(data, 'accessories')
    ? data.accessories
    : merged.accessories;
  if (hasAccessories && (!accessoriesText || !String(accessoriesText).trim())) {
    throw new HttpError(400, 'accessories is required when has_accessories is true');
  }

  for (const [flagField, chargeField] of [
    ['gift_options_available', 'gift_options_charge'],
    ['gift_wrap_available', 'gift_wrap_charge'],
  ]) {
    if (
      !Object.hasOwn(data, flagField) &&
      !merged[flagField] &&
      Object.hasOwn(data, chargeField) &&
      data[chargeField] !== null &&
      data[chargeField] !== undefined
    ) {
      throw new HttpError(400, `${chargeField} requires ${flagField} to be true`);
    }
    if (data[flagField] === false) {
      data[chargeField] = null;
    }
    const enabled = Object.hasOwn(data, flagField)
      ? data[flagField]
      : Boolean(merged[flagField]);
    const charge = Object.hasOwn(data, chargeField)
      ? data[chargeField]
      : merged[chargeField];
    if (enabled && (charge === null || charge === undefined)) {
      throw new HttpError(400, `${chargeField} is required when ${flagField} is true`);
    }
  }

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
