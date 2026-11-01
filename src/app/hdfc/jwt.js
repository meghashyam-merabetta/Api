import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { FlattenedSign, FlattenedEncrypt, flattenedDecrypt, flattenedVerify } from 'jose';
import { HttpError } from '../../shared/errors.js';

const encoder = new TextEncoder();
let cached;

// Keys remain on the backend. File changes invalidate the cache for key rotation.
export function loadJwtKeys(config) {
  try {
    const keyId = config.HDFC_JWT_KEY_ID;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(keyId || '')) throw Error('Invalid key ID');
    if (!config.HDFC_JWT_PRIVATE_KEY_PATH || !config.HDFC_JWT_BANK_PUBLIC_KEY_PATH)
      throw Error('Missing key paths');
    const paths = [config.HDFC_JWT_PRIVATE_KEY_PATH, config.HDFC_JWT_BANK_PUBLIC_KEY_PATH].map(p => resolve(p));
    const stats = paths.map(p => statSync(p));
    if (stats.some(s => !s.isFile() || s.size > 32768)) throw Error('Invalid key file');
    const stamp = JSON.stringify([keyId, paths, stats.map(s => [s.mtimeMs, s.ctimeMs, s.size])]);
    if (cached?.stamp === stamp) return cached.keys;
    const privatePem = readFileSync(paths[0], 'utf8');
    const publicPem = readFileSync(paths[1], 'utf8');
    if (publicPem.includes('PRIVATE KEY')) throw Error('Bank key must be public');
    const privateKey = createPrivateKey(privatePem);
    const publicKey = createPublicKey(publicPem);
    for (const key of [privateKey, publicKey]) {
      if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048)
        throw Error('RSA 2048-bit or stronger keys are required');
    }
    if (createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) === publicKey.export({ type: 'spki', format: 'pem' }))
      throw Error('Bank public key must not be the merchant public key');
    const keys = { keyId, privateKey, publicKey };
    cached = { stamp, keys };
    return keys;
  } catch {
    throw new HttpError(503, 'HDFC JWT keys are missing or invalid. Please contact support.');
  }
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid gateway payload');
  return value;
}

// HDFC's documented flattened JOSE mapping uses header/encryptedKey/encryptedPayload.
export async function encryptGatewayPayload(payload, { keyId, privateKey, publicKey }) {
  const signed = await new FlattenedSign(encoder.encode(JSON.stringify(object(payload))))
    .setProtectedHeader({ alg: 'RS256', kid: keyId }).sign(privateKey);
  const encrypted = await new FlattenedEncrypt(encoder.encode(JSON.stringify({
    header: signed.protected, payload: signed.payload, signature: signed.signature,
  }))).setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', cty: 'JWT', kid: keyId }).encrypt(publicKey);
  return {
    header: encrypted.protected, encryptedKey: encrypted.encrypted_key,
    iv: encrypted.iv, encryptedPayload: encrypted.ciphertext, tag: encrypted.tag,
  };
}

export async function decryptGatewayPayload(envelope, { keyId, privateKey, publicKey }) {
  object(envelope);
  for (const field of ['header', 'encryptedKey', 'iv', 'encryptedPayload', 'tag']) {
    if (typeof envelope[field] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope[field]))
      throw Error('Invalid encrypted gateway payload');
  }
  const decrypted = await flattenedDecrypt({
    protected: envelope.header, encrypted_key: envelope.encryptedKey,
    iv: envelope.iv, ciphertext: envelope.encryptedPayload, tag: envelope.tag,
  }, privateKey, { keyManagementAlgorithms: ['RSA-OAEP-256'], contentEncryptionAlgorithms: ['A256GCM'] });
  if (decrypted.protectedHeader.kid !== keyId) throw Error('Unexpected gateway key ID');
  const signed = object(JSON.parse(Buffer.from(decrypted.plaintext).toString('utf8')));
  const verified = await flattenedVerify({
    protected: signed.header, payload: signed.payload, signature: signed.signature,
  }, publicKey, { algorithms: ['RS256'] });
  if (verified.protectedHeader.kid !== undefined && verified.protectedHeader.kid !== keyId)
    throw Error('Unexpected signature key ID');
  return object(JSON.parse(Buffer.from(verified.payload).toString('utf8')));
}
