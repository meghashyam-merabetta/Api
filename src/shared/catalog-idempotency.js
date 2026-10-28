import { createHash } from 'node:crypto';
import { sequelize } from '../config/database.js';
import { AdminCatalogRequest } from '../models/catalog-reliability.model.js';
import { HttpError } from './errors.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const fingerprint = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

// The replay record commits with the mutation. The lock also serializes concurrent retries.
export async function catalogMutation(req, payload, status, execute) {
  const key = req.method === 'POST' ? req.get('Idempotency-Key') : undefined;
  if (key !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    throw new HttpError(
      400,
      'Idempotency-Key must contain 1–128 letters, digits, ., _, :, or -',
    );
  const actor = req.auth?.userId;
  if (key && !actor)
    throw new HttpError(401, 'Authentication required for idempotent requests');
  const id = key ? fingerprint([actor, req.method, req.baseUrl, req.path, key]) : null;
  const digest = key ? fingerprint(payload) : null;
  return sequelize.transaction(async (transaction) => {
    if (id) {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:id, 0))', {
        replacements: { id },
        transaction,
      });
      const previous = await AdminCatalogRequest.findByPk(id, { transaction });
      if (previous) {
        if (previous.fingerprint !== digest)
          throw new HttpError(
            409,
            'Idempotency-Key was already used with a different payload',
          );
        return { status: previous.status, body: previous.body, replayed: true };
      }
    }
    // Match serialized HTTP output on both the initial request and subsequent replays.
    const body = JSON.parse(JSON.stringify({ data: await execute(transaction) }));
    if (id)
      await AdminCatalogRequest.create(
        { id, fingerprint: digest, status, body },
        { transaction },
      );
    return { status, body, replayed: false };
  });
}
export function sendMutation(res, result) {
  if (result.replayed) res.set('Idempotency-Replayed', 'true');
  return res.status(result.status).json(result.body);
}
