import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { models } from '../src/models/index.js';
import { sequelize } from '../src/config/database.js';
import { updateProfile, addAddress, updateAddress, getCustomerAccount } from '../src/app/customers/customer.controller.js';
import { addressSchema, updateProfileSchema } from '../src/app/customers/customer.schema.js';

const customerId = randomUUID();
let result;
const response = { status() { return this; }, json(value) { result = value; } };
try {
  await models.customer.create({ id: customerId });
  await updateProfile({ credential: { id: customerId }, validated: updateProfileSchema.parse({ firstName: 'Flow', lastName: 'Test', phone: '9876543210', email: 'flow@example.com', dateOfBirth: '1990-01-01', gender: 'Other' }) }, response);
  assert.equal(result.user.profileCompleted, true);
  assert.equal(result.addresses.length, 0);
  assert.equal(result.members[0].dateOfBirth, '1990-01-01');
  assert.equal(result.members[0].gender, 'Other');
  const address = addressSchema.parse({ line1: 'Flat / house 12, Garden', line2: 'Baner Road', houseNumber: '12', buildingName: 'Garden', landmark: 'Gate 2', city: 'Pune', state: 'Maharashtra', postalCode: '411045', location: { provider: 'locationiq', placeId: '123', displayName: 'Baner Road, Pune, Maharashtra, India', latitude: 18.56, longitude: 73.78, address: { road: 'Baner Road', city: 'Pune', state: 'Maharashtra', postcode: '411045', country_code: 'in' } } });
  await addAddress({ credential: { id: customerId }, validated: address }, response);
  const saved = result.addresses[0];
  assert.equal(saved.ownerId, customerId);
  assert.deepEqual(saved.location, address.location);
  assert.equal(saved.latitude, 18.56);
  assert.equal(saved.longitude, 73.78);
  assert.equal(saved.houseNumber, '12');
  assert.equal(saved.buildingName, 'Garden');
  await updateAddress({ credential: { id: customerId }, validatedParams: { id: saved.id }, validated: { ...address, houseNumber: '14', line1: 'Flat / house 14, Garden' } }, response);
  const restored = await getCustomerAccount(customerId);
  assert.equal(restored.addresses.length, 1);
  assert.equal(restored.addresses[0].houseNumber, '14');
  assert.deepEqual(restored.addresses[0].location, address.location);
  await updateAddress({ credential: { id: customerId }, validatedParams: { id: saved.id }, validated: { ...address, location: { ...address.location, latitude: 18.57, longitude: 73.79 } } }, response);
  const moved = await models.customerAddress.findByPk(saved.id);
  assert.equal(moved.latitude, 18.57);
  assert.equal(moved.longitude, 73.79);
  assert.equal(result.addresses[0].latitude, 18.57);
  await updateAddress({ credential: { id: customerId }, validatedParams: { id: saved.id }, validated: { ...address, location: null } }, response);
  const cleared = await models.customerAddress.findByPk(saved.id);
  assert.equal(cleared.latitude, null);
  assert.equal(cleared.longitude, null);
  assert.equal(cleared.location, null);
  await assert.rejects(updateAddress({ credential: { id: randomUUID() }, validatedParams: { id: saved.id }, validated: address }, response), /Record not found/);
  console.log('PASS: onboarding without address; self member details; full LocationIQ address persistence, editing and ownership.');
} finally {
  await models.customerAddress.destroy({ where: { customerId }, force: true });
  await models.customerFamilyMember.destroy({ where: { customerId }, force: true });
  await models.customer.destroy({ where: { id: customerId }, force: true });
  await sequelize.close();
}
