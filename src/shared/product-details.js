import { z } from 'zod';
import { HttpError } from './errors.js';

// Flat API fields shared by validation, persistence and catalog publication.
export const additionalProductFields = {
  manufacturer_sku: z.string().trim().max(255).nullable().optional(),
  brand_type: z.enum(['company', 'generic']).nullable().optional(),
  is_customisable: z.boolean().nullable().optional(),
  model_number: z.string().trim().max(255).nullable().optional(),
  manufacturer_contact_name: z.string().trim().max(255).nullable().optional(),
  manufacturer_phone: z.string().trim().max(255).nullable().optional(),
  manufacturer_email: z.email().max(150).nullable().optional(),
  license_number: z.string().trim().max(255).nullable().optional(),
  repacker_name: z.string().trim().max(255).nullable().optional(),
  repacker_address: z.string().trim().max(2000).nullable().optional(),
  age_min: z.number().finite().int().min(0).max(2147483647).nullable().optional(),
  age_max: z.number().finite().int().min(0).max(2147483647).nullable().optional(),
  age_unit: z.enum(['years', 'months']).nullable().optional(),
  audience_age_group: z
    .enum(['infants', 'children', 'young people', 'adults', 'seniors', 'all ages'])
    .nullable()
    .optional(),
  product_uses: z.string().trim().max(2000).nullable().optional(),
  special_instructions: z.string().trim().max(2000).nullable().optional(),
  material_composition: z.string().trim().max(2000).nullable().optional(),
  material_type: z.string().trim().max(255).nullable().optional(),
  resistance_level: z.string().trim().max(255).nullable().optional(),
  heat_resistant: z.boolean().nullable().optional(),
  gas_resistant: z.boolean().nullable().optional(),
  physical_state: z.enum(['solid', 'liquid', 'gas']).nullable().optional(),
  pattern: z.string().trim().max(255).nullable().optional(),
  reusable: z.boolean().nullable().optional(),
  hazard_classification: z.string().trim().max(255).nullable().optional(),
  net_weight: z.number().finite().min(0).max(999999999).nullable().optional(),
  net_weight_unit: z.enum(['g', 'kg']).nullable().optional(),
  product_length: z.number().finite().min(0).max(999999999).nullable().optional(),
  product_breadth: z.number().finite().min(0).max(999999999).nullable().optional(),
  product_height: z.number().finite().min(0).max(999999999).nullable().optional(),
  product_dimension_unit: z.enum(['cm', 'mm', 'in']).nullable().optional(),
  manufacturing_date: z.iso.date().nullable().optional(),
  fulfillment_channel: z.enum(['merabetta', 'self']).nullable().optional(),
  seller_handling_days: z
    .number()
    .finite()
    .int()
    .min(0)
    .max(2147483647)
    .nullable()
    .optional(),
  business_offer_percent: z.number().finite().min(0).max(100).nullable().optional(),
  sale_start_date: z.iso.date().nullable().optional(),
  sale_end_date: z.iso.date().nullable().optional(),
  shipping_template: z.string().trim().max(255).nullable().optional(),
  seller_pincodes: z
    .array(z.string().regex(/^[1-9]\d{5}$/))
    .max(1000)
    .nullable()
    .optional(),
  accessories: z.string().trim().max(2000).nullable().optional(),
  battery_required: z.boolean().nullable().optional(),
  battery_consumption: z.string().trim().max(255).nullable().optional(),
  cosmetic_features: z.string().trim().max(2000).nullable().optional(),
};

export function validateAdditionalProductDetails(input, previous = {}) {
  const merged = { ...previous, ...input };
  const present = (key) => merged[key] !== null && merged[key] !== undefined;
  if (
    present('age_min') &&
    present('age_max') &&
    Number(merged.age_min) > Number(merged.age_max)
  )
    throw new HttpError(422, 'Minimum age cannot exceed maximum age');
  for (const [values, unit] of [
    [['age_min', 'age_max'], 'age_unit'],
    [['net_weight'], 'net_weight_unit'],
    [['product_length', 'product_breadth', 'product_height'], 'product_dimension_unit'],
  ]) {
    if (values.some(present) && !present(unit))
      throw new HttpError(422, `${unit} is required`);
  }
  if (
    present('sale_start_date') &&
    present('sale_end_date') &&
    merged.sale_start_date > merged.sale_end_date
  )
    throw new HttpError(422, 'Sale end date cannot be before the start date');
}
