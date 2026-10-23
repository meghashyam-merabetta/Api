import assert from 'node:assert/strict';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/config/database.js';
import { readPricingSettings, chargeBelow, settingsSchema } from '../src/app/pricing/settings.js';
import { labPricing } from '../src/app/coupons/pricing.js';
const rollback = new Error('rollback fixture');
try {
  assert.equal(settingsSchema.safeParse({ lab_markup_percent: -1 }).success, false);
  assert.equal(settingsSchema.safeParse({ product_handling_charge_paise: 1.5 }).success, false);
  assert.equal(chargeBelow(49900, 49900, 4000), 0);
  assert.equal(chargeBelow(49899, 49900, 4000), 4000);
  await sequelize.transaction(async transaction => {
    const query = sql => sequelize.query(sql, {transaction, type: QueryTypes.SELECT});
    await query("UPDATE pricing_settings SET lab_markup_percent=17,lab_collection_below_paise=70000,lab_collection_charge_paise=12000,product_handling_below_paise=50000,product_handling_charge_paise=2000 WHERE id=1 RETURNING id");
    const settings = await readPricingSettings(transaction);
    assert.equal(labPricing(69999, null, settings).collection, 120);
    assert.equal(labPricing(70000, null, settings).collection, 0);
    assert.equal(chargeBelow(49999, settings.product_handling_below_paise, settings.product_handling_charge_paise), 2000);
    const [prices] = await query(`SELECT count(*) AS mismatches FROM lab_packages WHERE lab_id='redcliffe'
      AND provider_data->'package_center_prices'->>'offer_price' ~ '^[0-9]+([.][0-9]+)?$'
      AND provider_data->'package_center_prices'->>'package_price' ~ '^[0-9]+([.][0-9]+)?$'
      AND (catalog_data->>'price')::numeric <> least((provider_data->'package_center_prices'->>'package_price')::numeric,
      ceil(round((provider_data->'package_center_prices'->>'offer_price')::numeric*100)*117/10000))`);
    assert.equal(Number(prices.mismatches), 0);
    throw rollback;
  }).catch(error => { if (error !== rollback) throw error; });
  console.log('PASS: configurable thresholds, handling fees, lab collection and markup/cap. Test updates rolled back.');
} finally { await sequelize.close(); }
