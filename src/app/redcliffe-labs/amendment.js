import { readPricingSettings } from '../pricing/settings.js';
import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { ageFromBirthdate } from '../../shared/birthdate.js';
import {
  providerRequest,
  paths,
  providerSucceeded,
  findProviderBooking,
} from './client.js';

import { editableBooking } from './eligibility.js';
export { editableBooking } from './eligibility.js';
export async function amendBooking(req, res) {
  const b = req.validated;
  const fingerprint = createHash('sha256').update(JSON.stringify(b)).digest('hex');
  const [row] = await sequelize.query(
    'SELECT *, updated_at::text AS observed_at FROM lab_bookings WHERE id=:id AND customer_id=:customer',
    {
      replacements: { id: req.validatedParams.id, customer: req.credential.id },
      type: QueryTypes.SELECT,
    },
  );
  if (!row) throw new HttpError(404, 'Booking not found.');
  if (row.amendment?.key === b.requestKey) {
    if (row.amendment.fingerprint !== fingerprint)
      throw new HttpError(409, 'This update request has different details.');
    if (row.amendment.state === 'completed') return res.json(row.payload);
    throw new HttpError(
      409,
      'This update is awaiting verification. Contact support before submitting it again.',
    );
  }
  if (
    row.integration_status !== 'confirmed' ||
    !/^[1-9]\d*$/.test(row.provider_booking_id)
  )
    throw new HttpError(409, 'This booking cannot be updated right now.');
  const latest = await providerRequest(paths.booking, {
    query: { booking_id: row.provider_booking_id },
  });
  const remote = findProviderBooking(latest, row.provider_booking_id);
  if (!editableBooking(remote) || !!remote?.phlebo)
    throw new HttpError(
      409,
      'Changes are available only before a collection agent is assigned.',
    );
  const items = [];
  for (const id of b.testIds) {
    const [test] = await sequelize.query(
      "SELECT catalog_data FROM lab_packages WHERE id=:id AND lab_id='redcliffe' AND active",
      { replacements: { id }, type: QueryTypes.SELECT },
    );
    if (!test) throw new HttpError(422, 'A selected test is unavailable.');
    items.push({ id, quantity: 1, snapshot: test.catalog_data });
  }
  const order = structuredClone(row.payload);
  let body, path;
  if (b.memberId) {
    if (
      row.member_id === b.memberId ||
      order.additionalMembers?.some((m) => m.id === b.memberId)
    )
      throw new HttpError(422, 'This family member is already included.');
    const member = await models.customerFamilyMember.findOne({
      where: { id: b.memberId, customerId: req.credential.id },
    });
    if (!member) throw new HttpError(404, 'Family member not found.');
    const age = ageFromBirthdate(member.dateOfBirth);
    if (
      age === null ||
      !['Male', 'Female'].includes(member.gender) ||
      !/^[a-zA-Z ]{3,30}$/.test(member.name.trim())
    )
      throw new HttpError(
        422,
        'Update this member name, birthdate and gender before booking.',
      );
    body = {
      additional_member: [
        {
          customer_name: member.name.trim(),
          customer_age: age,
          customer_gender: member.gender.toLowerCase(),
          packages: items.map((i) => i.snapshot.packageCode),
        },
      ],
    };
    path = `/api/external/v2/open-add-member/${row.provider_booking_id}/`;
    order.additionalMembers = [
      ...(order.additionalMembers || []),
      { id: member.id, name: member.name, age, gender: member.gender, items },
    ];
  } else {
    const existing = order.items.map((i) => i.snapshot?.packageCode);
    if (existing.some((code) => !code))
      throw new HttpError(409, 'Existing tests need verification. Contact support.');
    const added = items.filter((i) => !existing.includes(i.snapshot.packageCode));
    if (!added.length) throw new HttpError(422, 'Choose a new test to add.');
    body = {
      center_discount: order.discount || 0,
      packages: [...new Set([...existing, ...added.map((i) => i.snapshot.packageCode)])],
    };
    path = `/api/external/v2/open-set-package/${row.provider_booking_id}/`;
    order.items.push(...added);
  }
  if (order.pricingVersion === 1) {
    const allItems = [
      ...order.items,
      ...(order.additionalMembers || []).flatMap((member) => member.items),
    ];
    order.subtotal =
      allItems.reduce(
        (sum, item) => sum + Math.round(item.snapshot.price * 100) * item.quantity,
        0,
      ) / 100;
    // Preserve the discount already granted; amendments do not redeem another coupon.
    const settings = order.pricingSettings || await readPricingSettings();
    order.pricingSettings = settings;
    order.collection = Math.round((order.subtotal - order.discount) * 100) < settings.lab_collection_below_paise ? settings.lab_collection_charge_paise / 100 : 0;
    order.total =
      Math.round((order.subtotal - order.discount + order.collection) * 100) / 100;
  }
  const amendment = {
    key: b.requestKey,
    fingerprint,
    state: 'submitted',
    proposed: order,
    request: body,
  };
  const claim = await sequelize.query(
    "UPDATE lab_bookings SET integration_status='updating',amendment=CAST(:amendment AS jsonb),updated_at=now() WHERE id=:id AND integration_status='confirmed' AND (CAST(:observed AS timestamptz) IS NULL OR updated_at=CAST(:observed AS timestamptz)) RETURNING id",
    {
      replacements: {
        id: row.id,
        observed: row.observed_at ?? null,
        amendment: JSON.stringify(amendment),
      },
      type: QueryTypes.SELECT,
    },
  );
  if (!claim.length)
    throw new HttpError(
      409,
      'Booking details changed while checking availability. Refresh My Orders and try again.',
    );
  let result;
  try {
    result = await providerRequest(path, { body });
  } catch {
    await sequelize.query(
      "UPDATE lab_bookings SET integration_status='update_unknown',updated_at=now() WHERE id=:id",
      { replacements: { id: row.id } },
    );
    throw new HttpError(
      502,
      'The lab has not confirmed this update yet. Your existing booking is saved. Contact support before retrying.',
    );
  }
  if (!providerSucceeded(result)) {
    const rejected = /^(failed|failure)$/i.test(String(result.status));
    await sequelize.query(
      'UPDATE lab_bookings SET integration_status=:status,amendment=CAST(:amendment AS jsonb),updated_at=now() WHERE id=:id',
      {
        replacements: {
          id: row.id,
          status: rejected ? 'confirmed' : 'update_unknown',
          amendment: JSON.stringify({
            ...amendment,
            state: rejected ? 'rejected' : 'unknown',
            response: result,
          }),
        },
      },
    );
    throw new HttpError(
      409,
      'The lab could not confirm this change. Check booking status or contact support.',
    );
  }
  const price = result.discounted_price?.final_total_price;
  if (order.pricingVersion === 1) {
    if (price !== null && price !== undefined && Number.isFinite(Number(price)))
      order.providerTotal = Number(price);
    order.totalEstimated = false;
  } else if (
    price !== null &&
    price !== undefined &&
    Number.isFinite(Number(price)) &&
    Number(price) >= 0
  ) {
    order.total = Number(price);
    order.totalEstimated = false;
  } else {
    const additions = b.memberId
      ? items
      : items.filter((i) => !row.payload.items.some((old) => old.id === i.id));
    order.total += additions.reduce((sum, i) => sum + i.snapshot.price, 0);
    order.totalEstimated = true;
  }
  await sequelize.query(
    "UPDATE lab_bookings SET integration_status='confirmed',payload=CAST(:payload AS jsonb),amendment=CAST(:amendment AS jsonb),updated_at=now() WHERE id=:id",
    {
      replacements: {
        id: row.id,
        payload: JSON.stringify(order),
        amendment: JSON.stringify({ ...amendment, state: 'completed', response: result }),
      },
    },
  );
  res.json(order);
}
