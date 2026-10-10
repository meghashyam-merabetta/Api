import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { models } from '../src/models/index.js';
import { sequelize } from '../src/config/database.js';
import { createCustomerSession } from '../src/shared/customer-session.js';

const id = randomUUID();
try {
  await models.customer.create({ id });
  const token = await createCustomerSession(id, { validated: {}, get: () => '', ip: '127.0.0.1' });
  const response = await fetch('http://localhost:3000/api/app/customers/me/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-App-Client': 'native', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ firstName: 'Temporary', lastName: 'Profile Test', phone: '9876543210', email: 'profile-test@example.com', dateOfBirth: '1990-01-01', gender: 'Other' }),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ status: response.status, error: data.error, details: data.details }));
  assert.equal(data.user.profileCompleted, true);
  assert.equal(data.addresses.length, 0);
  assert.equal(data.members[0].relationship, 'Self');
  assert.equal(data.members[0].dateOfBirth, '1990-01-01');
  const saved = await models.customer.findByPk(id);
  assert.equal(saved.profileCompleted, true);
  console.log('PASS: running API saves first-time profile without an address and creates the Self family member.');
} finally {
  await models.customerAddress.destroy({ where: { customerId: id }, force: true });
  await models.customerFamilyMember.destroy({ where: { customerId: id }, force: true });
  await models.customerLoginLog.destroy({ where: { customerId: id }, force: true });
  await models.customer.destroy({ where: { id }, force: true });
  await sequelize.close();
}
