import { models } from '../../models/index.js';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import { clearCustomerCookie } from '../../shared/customer-session.js';
import { ageFromBirthdate } from '../../shared/birthdate.js';

// Derive both columns from the validated pin to keep one source of truth.
function addressFields(address) {
  return {
    ...address,
    location: address.location ?? null,
    latitude: address.location?.latitude ?? null,
    longitude: address.location?.longitude ?? null,
  };
}

export async function getProfile(req, res) {
  const account = await getCustomerAccount(req.credential.id);
  res.json(account);
}

export async function updateProfile(req, res) {
  const customerId = req.credential.id;
  const { address, ...profile } = req.validated;

  await sequelize.transaction(async (transaction) => {
    const customer = await models.customer.findByPk(customerId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!customer) throw new HttpError(401, 'Account unavailable');

    const identities = await models.customerIdentity.findAll({
      where: { customerId },
      transaction,
    });
    const changedVerifiedContact = identities.some(
      (identity) => profile[identity.method] !== identity.contact,
    );
    if (changedVerifiedContact) {
      throw new HttpError(422, 'Verified login contact cannot be changed here');
    }

    const firstCompletion = !customer.profileCompleted;
    await customer.update({ ...profile, profileCompleted: true }, { transaction });
    if (firstCompletion) {
      if (address)
        await models.customerAddress.create(
          { ...addressFields(address), customerId },
          { transaction },
        );
      await models.customerFamilyMember.create(
        {
          customerId,
          name: profile.firstName + ' ' + profile.lastName,
          relationship: 'Self',
          phone: profile.phone,
          dateOfBirth: profile.dateOfBirth,
          age: ageFromBirthdate(profile.dateOfBirth),
          gender: profile.gender,
        },
        { transaction },
      );
    }
  });

  const account = await getCustomerAccount(customerId);
  res.json(account);
}

export async function listAddresses(req, res) {
  const account = await getCustomerAccount(req.credential.id);
  res.json({ data: account.addresses });
}

export async function addAddress(req, res) {
  await models.customerAddress.create({
    ...addressFields(req.validated),
    customerId: req.credential.id,
  });
  const account = await getCustomerAccount(req.credential.id);
  res.status(201).json(account);
}

export async function updateAddress(req, res) {
  const address = await findOwnedRecord(
    models.customerAddress,
    req.validatedParams.id,
    req.credential.id,
  );
  await address.update(addressFields(req.validated));
  const account = await getCustomerAccount(req.credential.id);
  res.json(account);
}

export async function deleteAddress(req, res) {
  const address = await findOwnedRecord(
    models.customerAddress,
    req.validatedParams.id,
    req.credential.id,
  );
  await address.destroy();
  const account = await getCustomerAccount(req.credential.id);
  res.json(account);
}

export async function listFamilyMembers(req, res) {
  const account = await getCustomerAccount(req.credential.id);
  res.json({ data: account.members });
}

export async function addFamilyMember(req, res) {
  await models.customerFamilyMember.create({
    ...req.validated,
    phone: req.validated.phone || null,
    customerId: req.credential.id,
  });
  const account = await getCustomerAccount(req.credential.id);
  res.status(201).json(account);
}

export async function updateFamilyMember(req, res) {
  const member = await findOwnedRecord(
    models.customerFamilyMember,
    req.validatedParams.id,
    req.credential.id,
  );
  await member.update({ ...req.validated, phone: req.validated.phone || null });
  const account = await getCustomerAccount(req.credential.id);
  res.json(account);
}

export async function deleteFamilyMember(req, res) {
  const member = await findOwnedRecord(
    models.customerFamilyMember,
    req.validatedParams.id,
    req.credential.id,
  );
  await member.destroy();
  const account = await getCustomerAccount(req.credential.id);
  res.json(account);
}

export async function deleteAccount(req, res) {
  const customerId = req.credential.id;
  await sequelize.transaction(async (transaction) => {
    for (const table of ['customer_cart_items', 'customer_wishlist_items']) {
      await sequelize.query(`DELETE FROM ${table} WHERE customer_id=:customerId`, {
        replacements: { customerId }, transaction,
      });
    }
    for (const Model of [
      models.customerAddress,
      models.customerFamilyMember,
      models.customerLoginLog,
    ]) {
      await Model.destroy({ where: { customerId }, transaction });
    }
    await models.customer.destroy({ where: { id: customerId }, transaction });
  });
  clearCustomerCookie(res);
  res.status(204).end();
}

export async function getCustomerAccount(customerId, transaction) {
  const customer = await models.customer.findByPk(customerId, { transaction });
  if (!customer) throw new HttpError(401, 'Account unavailable');

  const identities = await models.customerIdentity.findAll({
    where: { customerId },
    attributes: ['method', 'contact'],
    raw: true,
    transaction,
  });
  const addresses = await models.customerAddress.findAll({
    where: { customerId },
    attributes: [
      'id',
      ['customer_id', 'ownerId'],
      'line1',
      'line2',
      'landmark',
      'state',
      'city',
      'postalCode',
      'houseNumber',
      'buildingName',
      'location',
      'latitude',
      'longitude',
    ],
    order: [['createdAt', 'ASC']],
    raw: true,
    transaction,
  });
  const members = await models.customerFamilyMember.findAll({
    where: { customerId },
    attributes: ['id', 'name', 'relationship', 'phone', 'age', 'gender', 'dateOfBirth'],
    order: [['createdAt', 'ASC']],
    raw: true,
    transaction,
  });

  return {
    user: {
      id: customer.id,
      name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
      firstName: customer.firstName || '',
      lastName: customer.lastName || '',
      phone: customer.phone || '',
      email: customer.email || '',
      dateOfBirth: customer.dateOfBirth,
      gender: customer.gender,
      profileCompleted: customer.profileCompleted,
    },
    identities,
    addresses,
    members: members.map((member) => ({ ...member, phone: member.phone || '' })),
  };
}

async function findOwnedRecord(Model, id, customerId) {
  const record = await Model.findOne({ where: { id, customerId } });
  if (!record) throw new HttpError(404, 'Record not found');
  return record;
}
