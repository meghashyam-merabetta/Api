// One-off administrative backfill. Dry run by default; --apply writes changes.
// Never run automatically on startup: future users must verify both contacts.
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/config/database.js';

const apply = process.argv.includes('--apply');
try {
  await sequelize.transaction(async transaction => {
    await sequelize.query('LOCK TABLE customers, customer_identities IN SHARE ROW EXCLUSIVE MODE', { transaction });
    const customers = await sequelize.query('SELECT id, phone, email FROM customers WHERE deleted_at IS NULL', { type: QueryTypes.SELECT, transaction });
    const identities = await sequelize.query('SELECT * FROM customer_identities', { type: QueryTypes.SELECT, transaction });
    const candidates = customers.flatMap(c => ['phone', 'email'].map(method => ({ customerId: c.id, method, contact: method === 'email' ? (c.email || '').trim().toLowerCase() : (c.phone || '').trim() })));
    const counts = new Map();
    for (const c of candidates) {
      const key = c.method + ':' + c.contact;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const report = { apply, users: customers.length, alreadyVerified: 0, toVerify: 0, missingOrInvalid: 0, conflicts: 0 };
    const changes = [];
    for (const c of candidates) {
      const valid = c.method === 'phone' ? /^[6-9]\d{9}$/.test(c.contact) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.contact);
      if (!valid) { report.missingOrInvalid++; continue; }
      const owned = identities.find(i => i.customer_id === c.customerId && i.method === c.method);
      const other = identities.find(i => i.method === c.method && i.contact.toLowerCase() === c.contact && i.customer_id !== c.customerId);
      if (other || (owned && owned.contact !== c.contact) || counts.get(c.method + ':' + c.contact) > 1) { report.conflicts++; continue; }
      if (owned?.verified_at) { report.alreadyVerified++; continue; }
      report.toVerify++;
      changes.push({ ...c, before: owned || null });
    }
    if (apply && changes.length) {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS customer_contact_backfill_audit (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL, method varchar(5) NOT NULL,
        contact varchar(254) NOT NULL, previous_identity jsonb, identity_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now())`, { transaction });
      for (const c of changes) {
        const identityId = c.before?.id || randomUUID();
        await sequelize.query('INSERT INTO customer_contact_backfill_audit(id,customer_id,method,contact,previous_identity,identity_id) VALUES(:id,:customerId,:method,:contact,CAST(:before AS jsonb),:identityId)', { replacements: { ...c, id: randomUUID(), before: JSON.stringify(c.before), identityId }, transaction, logging: false });
        if (c.before) await sequelize.query('UPDATE customer_identities SET verified_at=now() WHERE id=:id', { replacements: { id: identityId }, transaction });
        else await sequelize.query('INSERT INTO customer_identities(id,customer_id,method,contact,verified_at) VALUES(:id,:customerId,:method,:contact,now())', { replacements: { ...c, id: identityId }, transaction, logging: false });
        if (c.method === 'email') await sequelize.query('UPDATE customers SET email=:contact WHERE id=:customerId', { replacements: c, transaction, logging: false });
      }
    }
    console.log(JSON.stringify(report));
  });
} finally { await sequelize.close(); }
