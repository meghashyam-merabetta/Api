// Independent bank simulator: Node crypto rather than the application's JOSE library.
import { generateKeyPairSync, publicEncrypt, privateDecrypt, createCipheriv, createDecipheriv, randomBytes, sign, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';

const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchant = keyPair();
const bank = keyPair();
const keyId = 'key_test_fixture';
const encoded = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function bankResponse(payload, options = {}) {
  const header = encoded({ alg: 'RS256', kid: keyId });
  const content = encoded(payload);
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${content}`), options.wrongSigner ? merchant.privateKey : bank.privateKey).toString('base64url');
  const jws = JSON.stringify({ header, payload: content, signature });
  const protectedHeader = encoded({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: options.keyId || keyId });
  const cek = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(protectedHeader));
  const ciphertext = Buffer.concat([cipher.update(jws), cipher.final()]);
  return {
    header: protectedHeader,
    encryptedKey: publicEncrypt({ key: merchant.publicKey, oaepHash: 'sha256' }, cek).toString('base64url'),
    iv: iv.toString('base64url'), encryptedPayload: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'),
  };
}

export function bankRead(envelope) {
  assert.deepEqual(JSON.parse(Buffer.from(envelope.header, 'base64url')), { alg: 'RSA-OAEP-256', enc: 'A256GCM', cty: 'JWT', kid: keyId });
  const cek = privateDecrypt({ key: bank.privateKey, oaepHash: 'sha256' }, Buffer.from(envelope.encryptedKey, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', cek, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAAD(Buffer.from(envelope.header));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const signed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.encryptedPayload, 'base64url')), decipher.final()]));
  assert.deepEqual(JSON.parse(Buffer.from(signed.header, 'base64url')), { alg: 'RS256', kid: keyId });
  assert.ok(verify('RSA-SHA256', Buffer.from(`${signed.header}.${signed.payload}`), merchant.publicKey, Buffer.from(signed.signature, 'base64url')));
  return JSON.parse(Buffer.from(signed.payload, 'base64url'));
}

export function setupHdfc(t) {
  const original = { ...env };
  const directory = mkdtempSync(join(tmpdir(), 'merabetta-hdfc-test-'));
  const privatePath = join(directory, 'merchant.pem'), publicPath = join(directory, 'bank.pem');
  writeFileSync(privatePath, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(publicPath, bank.publicKey.export({ type: 'spki', format: 'pem' }));
  Object.assign(env, {
    HDFC_JWT_KEY_ID: keyId, HDFC_JWT_PRIVATE_KEY_PATH: privatePath, HDFC_JWT_BANK_PUBLIC_KEY_PATH: publicPath,
    HDFC_ENVIRONMENT: 'sandbox', HDFC_MERCHANT_ID: 'audit', HDFC_CLIENT_ID: 'hdfcmaster',
    HDFC_RETURN_URL: 'https://uat.example.test/api/payments/hdfc/return',
    HDFC_WEBHOOK_USER: 'testhook', HDFC_WEBHOOK_PASSWORD: 'test-only-webhook-password',
  });
  const cleanup = () => { Object.assign(env, original); rmSync(directory, { recursive: true, force: true }); };
  t?.after(cleanup);
  return { cleanup, merchant, bank };
}
