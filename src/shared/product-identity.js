import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { HttpError } from './errors.js';

export async function independentProductId(id, transaction) {
  let rows;
  if (/^shop:\d+$/.test(id)) {
    rows = await sequelize.query(
      'SELECT m.independent_product_id AS id FROM vendor_products o JOIN legacy_variant_products m ON m.variant_id=o.variant_id WHERE o.id=:id',
      { replacements: { id: id.slice(5) }, type: QueryTypes.SELECT, transaction },
    );
  } else if (/^(?:product:)?\d+$/.test(id)) {
    rows = [{ id: id.replace(/^product:/, '') }];
  } else if (/^variant:\d+$/.test(id)) {
    rows = await sequelize.query(
      'SELECT independent_product_id AS id FROM legacy_variant_products WHERE variant_id=:id',
      { replacements: { id: id.slice(8) }, type: QueryTypes.SELECT, transaction },
    );
  }
  if (!rows?.length)
    throw new HttpError(
      422,
      'Product configuration requires migration or is unavailable',
    );
  return String(rows[0].id);
}
