import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';

// Serialize account linking before taking contact/customer locks.
export async function lockAccountLinking(transaction) {
  await sequelize.query(
    "SELECT pg_advisory_xact_lock(hashtext('customer-account-linking'))",
    { transaction },
  );
}
async function isEmpty(customer, transaction) {
  if (!customer || customer.profileCompleted) return false;
  const [row] = await sequelize.query(
    `SELECT
    EXISTS(SELECT 1 FROM customer_addresses WHERE customer_id=:id) OR
    EXISTS(SELECT 1 FROM customer_family_members WHERE customer_id=:id) OR
    EXISTS(SELECT 1 FROM orders WHERE customer_id=:id) OR
    EXISTS(SELECT 1 FROM product_checkouts WHERE customer_id=:id) OR
    EXISTS(SELECT 1 FROM lab_bookings WHERE customer_id=:id) OR
    EXISTS(SELECT 1 FROM customer_cart_items WHERE customer_id=:id) OR
    EXISTS(SELECT 1 FROM customer_wishlist_items WHERE customer_id=:id) AS activity`,
    { replacements: { id: customer.id }, type: QueryTypes.SELECT, transaction },
  );
  return !row.activity;
}

// Invoke only after OTP proof for the new contact. Preserve the account with data.
export async function linkVerifiedContact(customerId, method, contact, transaction) {
  const current = await models.customer.findByPk(customerId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const identity = await models.customerIdentity.findOne({
    where: { method, contact },
    transaction,
  });
  const own = await models.customerIdentity.findOne({
    where: { customerId, method },
    transaction,
  });
  if (own && own.contact !== contact)
    throw new HttpError(409, 'A different contact is already verified for this account.');
  if (!identity || identity.customerId === customerId) {
    if (!identity)
      await models.customerIdentity.create(
        { customerId, method, contact },
        { transaction },
      );
    await current.update({ [method]: contact }, { transaction });
    return customerId;
  }
  const other = await models.customer.findByPk(identity.customerId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!other) throw new HttpError(409, 'This contact is unavailable. Contact support.');
  let source, target;
  if (await isEmpty(current, transaction)) {
    source = current;
    target = other;
  } else if (await isEmpty(other, transaction)) {
    source = other;
    target = current;
  } else
    throw new HttpError(
      409,
      'Both accounts have saved details. Contact support to link them without losing data.',
    );
  const sourceIdentities = await models.customerIdentity.findAll({
    where: { customerId: source.id },
    transaction,
  });
  const targetIdentities = await models.customerIdentity.findAll({
    where: { customerId: target.id },
    transaction,
  });
  if (
    sourceIdentities.some((i) =>
      targetIdentities.some((t) => t.method === i.method && t.contact !== i.contact),
    )
  )
    throw new HttpError(
      409,
      'This account already has a different verified mobile or email. Contact support.',
    );
  for (const item of sourceIdentities) {
    await item.update({ customerId: target.id }, { transaction });
    await target.update({ [item.method]: item.contact }, { transaction });
    await models.customerOtpChallenge.update(
      { consumedAt: new Date() },
      {
        where: { method: item.method, contact: item.contact, consumedAt: null },
        transaction,
      },
    );
  }
  await models.customerLoginLog.destroy({
    where: { customerId: source.id },
    transaction,
  });
  await source.update({ phone: null, email: null }, { transaction });
  return target.id;
}