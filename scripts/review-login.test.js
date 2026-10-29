import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewOtpFor } from '../src/shared/review-login.js';
import { requestOtp } from '../src/app/auth/auth.controller.js';
import { env } from '../src/config/env.js';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import { hashOtp } from '../src/shared/customer-otp.js';

const config = { APP_REVIEW_EMAIL: 'info@merabetta.com', APP_REVIEW_OTP: '839271' };
test('review OTP is limited to the configured email, never phone or another user', () => {
  assert.equal(reviewOtpFor('email', 'info@merabetta.com', config), '839271');
  assert.equal(reviewOtpFor('email', 'other@merabetta.com', config), null);
  assert.equal(reviewOtpFor('phone', 'info@merabetta.com', config), null);
  assert.equal(reviewOtpFor('email', 'info@merabetta.com.evil.test', config), null);
});
test('review login is disabled without both configuration values', () => {
  assert.equal(reviewOtpFor('email', 'info@merabetta.com', {}), null);
  assert.equal(reviewOtpFor('email', 'info@merabetta.com', { ...config, APP_REVIEW_OTP: '' }), null);
  assert.equal(reviewOtpFor('email', 'info@merabetta.com', { ...config, APP_REVIEW_EMAIL: '' }), null);
});

test('production review request hashes the code without delivery or disclosure; ordinary email stays blocked', async (t) => {
  const previous = { ...env };
  Object.assign(env, config, { NODE_ENV: 'production', EMAIL_OTP_MODE: 'disabled', OTP_MODE: 'disabled' });
  t.after(() => Object.assign(env, previous));
  t.mock.method(sequelize, 'transaction', async (fn) => fn({}));
  t.mock.method(sequelize, 'query', async () => []);
  t.mock.method(models.customerOtpChallenge, 'findOne', async () => null);
  t.mock.method(models.customerOtpChallenge, 'update', async () => [0]);
  let saved;
  t.mock.method(models.customerOtpChallenge, 'create', async (row) => { saved = row; return row; });
  let response;
  await requestOtp({ validated: { method: 'email', contact: config.APP_REVIEW_EMAIL } }, { json: (body) => { response = body; } });
  assert.equal(saved.codeHash, hashOtp(saved.id, config.APP_REVIEW_OTP));
  assert.ok(saved.expiresAt > new Date());
  assert.equal(response.devCode, undefined);
  assert.equal(JSON.stringify(response).includes(config.APP_REVIEW_OTP), false);
  await assert.rejects(requestOtp({ validated: { method: 'email', contact: 'other@merabetta.com' } }, {}), /not configured/);
});
