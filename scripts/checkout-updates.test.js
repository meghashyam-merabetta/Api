import test from 'node:test';
import assert from 'node:assert/strict';
import { couponDiscount, labPricing as configuredLabPricing } from '../src/app/coupons/pricing.js';
import { formatAddress } from '../src/shared/address.js';
import { savedAddressSchema } from '../src/app/customers/customer.schema.js';
import { recordProviderCall } from '../src/shared/provider-log.js';
import { sequelize } from '../src/config/database.js';

test('coupon rounds up to rupees before collection threshold is evaluated', () => {
  assert.equal(couponDiscount(10400, {percent:10,max_discount_paise:10000}), 1100);
  assert.equal(couponDiscount(100000, {percent:20,max_discount_paise:10000}), 10000);
  assert.equal(labPricing(66550, {percent:10,max_discount_paise:10000}).collection, 150);
});
test('saved address requires locality and address text removes duplicate fragments', () => {
  const address = {line1:'Flat 12',line2:'Baner',landmark:'Gate 2',city:'Pune',state:'Maharashtra',postalCode:'411045',houseNumber:'12'};
  assert.equal(savedAddressSchema.safeParse(address).success,false);
  const selected = {...address,location:{provider:'locationiq',placeId:'1',displayName:'Baner, Pune, Maharashtra, 411045',latitude:18.56,longitude:73.78,address:{}}};
  assert.equal(savedAddressSchema.safeParse(selected).success,true);
  assert.equal(formatAddress(selected),'Flat 12, Baner, Gate 2, Pune, Maharashtra, 411045');
  const snapshot=structuredClone(selected);
  selected.line1='Flat 99'; selected.location.displayName='New locality';
  assert.match(formatAddress(snapshot),/^Flat 12/);
  assert.match(formatAddress(snapshot),/Baner/);
});
test('provider response text is preserved verbatim in database replacements', async () => {
  const original=sequelize.query;
  const raw=' { "status": "success", "data": [1, 2] }\n';
  sequelize.query=async (_sql,options)=>{ assert.equal(options.replacements.responseBody,raw); assert.equal(options.logging,false); };
  try {await recordProviderCall({providerRequestId:'id',provider:'redcliffe',endpoint:'/test',method:'GET',httpStatus:200,responseBody:raw});}
  finally {sequelize.query=original;}
});

function labPricing(subtotal, coupon) { return configuredLabPricing(subtotal, coupon, {lab_collection_below_paise:59900,lab_collection_charge_paise:15000}); }
