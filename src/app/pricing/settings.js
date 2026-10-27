import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from '../../config/database.js';
const amount = z.number().int().min(0).max(100000000);
export const settingsSchema = z.object({
  product_delivery_charge_paise: amount.optional(), product_delivery_below_paise: amount.optional(),
  product_handling_charge_paise: amount.optional(), product_handling_below_paise: amount.optional(),
  lab_collection_charge_paise: amount.optional(), lab_collection_below_paise: amount.optional(),
  lab_markup_percent: z.number().min(0).max(100).multipleOf(0.01).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one setting');
export async function readPricingSettings(transaction) {
  const [row] = await sequelize.query('SELECT * FROM pricing_settings WHERE id=1', { type: QueryTypes.SELECT, transaction });
  if (!row) throw new Error('Pricing settings missing; run migrations');
  return { ...row, lab_markup_percent: Number(row.lab_markup_percent) };
}
export const getSettings = async (_req, res) => res.json({ data: await readPricingSettings() });
export async function updateSettings(req, res) {
  const values = req.validated;
  await sequelize.transaction(async transaction => {
    await sequelize.query(`UPDATE pricing_settings SET ${Object.keys(values).map(key => `${key}=:${key}`).join(',')} WHERE id=1`, { replacements: values, transaction });
  });
  res.json({ data: await readPricingSettings() });
}
export function chargeBelow(amount, threshold, charge) { return amount < threshold ? charge : 0; }
