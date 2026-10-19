// Explicit non-production integration check; creates and removes fixtures.
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { sequelize } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { models } from '../src/models/index.js';
import {
  requestEmailVerification,
  verifyProfileEmail,
} from '../src/app/customers/email-verification.js';
import {
  requestPhoneVerification,
  verifyProfilePhone,
} from '../src/app/customers/phone-verification.js';
import { requestOtp, verifyOtp } from '../src/app/auth/auth.controller.js';
import {
  updateProfile,
  getCustomerAccount,
} from '../src/app/customers/customer.controller.js';
assert.notEqual(env.NODE_ENV, 'production');
env.EMAIL_OTP_MODE = 'inherit';
env.OTP_MODE = 'development';
const ids = [],
  contacts = [];
async function fixture(method, completed = false) {
  const email = 'verify-' + randomUUID() + '@example.com',
    phone = '9' + String(randomInt(0, 1e9)).padStart(9, '0');
  contacts.push(email, phone);
  const row = await models.customer.create({
    email: method === 'email' ? email : null,
    phone: method === 'phone' ? phone : null,
    firstName: 'Original',
    profileCompleted: completed,
  });
  ids.push(row.id);
  await models.customerIdentity.create({
    customerId: row.id,
    method,
    contact: method === 'phone' ? phone : email,
  });
  return { id: row.id, email, phone };
}
async function call(handler, id, validated) {
  let body;
  await handler(
    {
      credential: { id },
      validated,
      ip: '127.0.0.1',
      get: (key) => (key === 'x-app-client' ? 'native' : ''),
    },
    {
      json: (value) => {
        body = value;
      },
      cookie() {},
    },
  );
  return body;
}
async function emailProof(id, email) {
  const c = await call(requestEmailVerification, id, { email });
  return { challengeId: c.challengeId, code: c.devCode };
}
async function phoneProof(id, phone) {
  const c = await call(requestPhoneVerification, id, { phone });
  return { challengeId: c.challengeId, code: c.devCode };
}
async function login(method, contact) {
  await models.customerOtpChallenge.update(
    { createdAt: new Date(0) },
    { where: { method, contact } },
  );
  const c = await call(requestOtp, null, { method, contact });
  return call(verifyOtp, null, { challengeId: c.challengeId, code: c.devCode });
}
try {
  // Mobile signup cannot complete until email is verified.
  const mobile = await fixture('phone');
  const profile = {
    firstName: 'Original',
    lastName: 'Fixture',
    phone: mobile.phone,
    email: mobile.email,
    dateOfBirth: '2000-01-01',
    gender: 'Other',
  };
  await assert.rejects(call(updateProfile, mobile.id, profile));
  const ep = await emailProof(mobile.id, mobile.email);
  await assert.rejects(call(verifyProfileEmail, mobile.id, { ...ep, code: '000000' }));
  await call(verifyProfileEmail, mobile.id, ep);
  await assert.rejects(call(verifyProfileEmail, mobile.id, ep));
  assert.equal(
    (await call(updateProfile, mobile.id, profile)).user.profileCompleted,
    true,
  );
  assert.equal((await login('phone', mobile.phone)).user.id, mobile.id);
  assert.equal((await login('email', mobile.email)).user.id, mobile.id);
  // Existing mobile profile plus fresh email signup: phone proof opens original account.
  const old = await fixture('phone', true),
    fresh = await fixture('email');
  assert.equal((await getCustomerAccount(old.id)).user.profileCompleted, false);
  const pp = await phoneProof(fresh.id, old.phone);
  await assert.rejects(call(verifyOtp, null, pp));
  await assert.rejects(call(verifyProfilePhone, mobile.id, pp));
  const linked = await call(verifyProfilePhone, fresh.id, pp);
  assert.equal(linked.user.id, old.id);
  assert.equal(linked.user.profileCompleted, true);
  assert.ok(linked.token);
  assert.equal((await login('email', fresh.email)).user.id, old.id);
  assert.equal((await login('phone', old.phone)).user.id, old.id);
  assert.equal(
    await models.customerIdentity.count({ where: { customerId: fresh.id } }),
    0,
  );
  // Reverse direction: fresh mobile signup links to existing email profile.
  const oldEmail = await fixture('email', true),
    freshMobile = await fixture('phone');
  const reverse = await emailProof(freshMobile.id, oldEmail.email);
  const reverseLinked = await call(verifyProfileEmail, freshMobile.id, reverse);
  assert.equal(reverseLinked.user.id, oldEmail.id);
  assert.ok(reverseLinked.token);
  assert.equal((await login('phone', freshMobile.phone)).user.id, oldEmail.id);
  // New email account cannot complete without mobile OTP.
  const freshEmail = await fixture('email');
  const emailProfile = { ...profile, email: freshEmail.email, phone: freshEmail.phone };
  await assert.rejects(call(updateProfile, freshEmail.id, emailProfile));
  const mobileProof = await phoneProof(freshEmail.id, freshEmail.phone);
  await call(verifyProfilePhone, freshEmail.id, mobileProof);
  assert.equal(
    (await call(updateProfile, freshEmail.id, emailProfile)).user.profileCompleted,
    true,
  );
  // Never silently merge two accounts with saved details.
  const fullPhone = await fixture('phone', true),
    fullEmail = await fixture('email', true);
  const conflict = await phoneProof(fullEmail.id, fullPhone.phone);
  await assert.rejects(call(verifyProfilePhone, fullEmail.id, conflict));
  assert.equal(
    (
      await models.customerIdentity.findOne({
        where: { method: 'phone', contact: fullPhone.phone },
      })
    ).customerId,
    fullPhone.id,
  );
  console.log(
    'Passed: mandatory mobile and email, same-account login, existing account linking in both directions, OTP ownership/purpose/replay and saved-data conflict protection.',
  );
} finally {
  if (ids.length) {
    await sequelize.query(
      'DELETE FROM customer_phone_verifications WHERE customer_id IN (:ids)',
      { replacements: { ids } },
    );
    await sequelize.query(
      'DELETE FROM customer_email_verifications WHERE customer_id IN (:ids)',
      { replacements: { ids } },
    );
    await models.customerFamilyMember.destroy({
      where: { customerId: ids },
      force: true,
    });
    await models.customerLoginLog.destroy({ where: { customerId: ids }, force: true });
    await models.customerIdentity.destroy({ where: { customerId: ids } });
    await models.customer.destroy({ where: { id: ids }, force: true });
  }
  if (contacts.length)
    await models.customerOtpChallenge.destroy({ where: { contact: contacts } });
  await sequelize.close();
}
