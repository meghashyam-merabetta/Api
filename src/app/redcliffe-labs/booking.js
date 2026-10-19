import { formatAddress } from '../../shared/address.js';
import { createHash, randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { ageFromBirthdate } from '../../shared/birthdate.js';
import { paths, providerRequest, providerSucceeded } from './client.js';
import { availableSlots, todayInIndia } from './slots.js';

import { resolveCoupon } from '../coupons/routes.js';
import { labPricing } from '../coupons/pricing.js';
import { paise } from '../orders/orders.controller.js';

export function bookingPayload(
  customer,
  member,
  address,
  codes,
  date,
  slotId,
  reference,
) {
  const age = ageFromBirthdate(member.dateOfBirth);
  if (age === null)
    throw new HttpError(422, 'Update the family member birthdate before booking.');
  if (!['Male', 'Female'].includes(member.gender))
    throw new HttpError(
      422,
      'Redcliffe currently supports bookings only for members whose saved gender is Male or Female.',
    );
  if (!/^[a-zA-Z ]{3,30}$/.test(member.name.trim()))
    throw new HttpError(
      422,
      'Redcliffe requires the patient name to contain 3–30 letters and spaces. Please review the saved name.',
    );
  const primary = member.phone || customer.phone;
  if (!/^[6-9]\d{9}$/.test(primary || '') || !/^[6-9]\d{9}$/.test(customer.phone || ''))
    throw new HttpError(422, 'A valid customer mobile number is required for booking.');
  if (!customer.email)
    throw new HttpError(
      422,
      'Add an email address to your customer profile before booking.',
    );
  if (
    !address.location ||
    !Number.isFinite(address.location.latitude) ||
    !Number.isFinite(address.location.longitude)
  )
    throw new HttpError(422, 'Select an area / locality for this address.');
  if (!address.landmark?.trim())
    throw new HttpError(
      422,
      'Redcliffe requires a nearby landmark. Edit your collection address to add one.',
    );
  return {
    booking_date: todayInIndia(),
    collection_date: date,
    collection_slot: Number(slotId),
    booking_type: 'Homedx',
    client_refid: customer.id,
    reference_data: reference,
    package_code: codes,
    customer_name: member.name.trim(),
    customer_age: age,
    customer_gender: member.gender.toLowerCase(),
    customer_email: customer.email,
    customer_phonenumber: primary,
    ...(member.phone ? { customer_altphonenumber: customer.phone } : {}),
    customer_whatsapppnumber: primary,
    customer_address: [address.line1, address.location.displayName]
      .filter(Boolean)
      .join(', '),
    address_line2: address.line2 || '',
    customer_landmark: address.landmark,
    pincode: address.postalCode,
    customer_latitude: address.location.latitude,
    customer_longitude: address.location.longitude,
    is_credit: false,
    additional_member: [],
  };
}

async function updateBooking(id, integrationStatus, order, extra = {}) {
  await sequelize.query(
    `UPDATE lab_bookings SET integration_status=:status,payload=CAST(:payload AS jsonb),
    provider_booking_id=COALESCE(:providerId,provider_booking_id),
    provider_response=COALESCE(CAST(:response AS jsonb),provider_response),
    confirmation_response=COALESCE(CAST(:confirmation AS jsonb),confirmation_response),last_error=:error,updated_at=now() WHERE id=:id`,
    {
      replacements: {
        id,
        status: integrationStatus,
        payload: JSON.stringify(order),
        providerId: extra.providerId ?? null,
        response: extra.response ? JSON.stringify(extra.response) : null,
        confirmation: extra.confirmation ? JSON.stringify(extra.confirmation) : null,
        error: extra.error || null,
      },
    },
  );
}

export async function createBooking(req, res) {
  const customer = req.credential;
  const b = req.validated;
  const fingerprint = createHash('sha256').update(JSON.stringify(b)).digest('hex');
  const old = await sequelize.query(
    'SELECT * FROM lab_bookings WHERE customer_id=:customerId AND request_key=:key',
    {
      replacements: { customerId: customer.id, key: b.requestKey },
      type: QueryTypes.SELECT,
    },
  );
  if (old.length) {
    if (old[0].request_fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'This booking request has already been used with different details.',
      );
    if (old[0].integration_status === 'confirmed') return res.json(old[0].payload);
    if (
      ['submitting', 'created', 'confirming', 'unknown', 'confirmation_unknown'].includes(
        old[0].integration_status,
      )
    )
      return res.status(202).json(old[0].payload);
    throw new HttpError(
      409,
      'This booking has already been submitted. Check My Orders before creating another booking.',
    );
  }
  const member = await models.customerFamilyMember.findOne({
    where: { id: b.memberId, customerId: customer.id },
  });
  if (!member) throw new HttpError(422, 'Select a saved family member.');
  if (
    !(await models.lab.findOne({
      where: { id: 'redcliffe', active: true, homeCollection: true },
    }))
  )
    throw new HttpError(422, 'Redcliffe home collection is currently unavailable.');
  const items = [];
  for (const item of b.items) {
    if (item.quantity !== 1)
      throw new HttpError(422, 'Each test can be booked once per family member.');
    const rows = await sequelize.query(
      "SELECT catalog_data FROM lab_packages WHERE id=:id AND lab_id='redcliffe' AND active",
      { replacements: { id: item.id }, type: QueryTypes.SELECT },
    );
    if (!rows.length)
      throw new HttpError(422, 'A selected test is unavailable. Refresh the test list.');
    items.push({ id: item.id, quantity: 1, snapshot: rows[0].catalog_data });
  }
  const coupon = await resolveCoupon(b.couponCode, 'labs');
  const pricing = labPricing(
    items.reduce((sum, item) => sum + paise(item.snapshot.price), 0),
    coupon,
  );
  const id = randomUUID();
  const outgoing = bookingPayload(
    customer,
    member,
    b.address,
    items.map((item) => item.snapshot.packageCode),
    b.collectionDate,
    b.slotId,
    id,
  );
  if (coupon) outgoing.center_discount = pricing.discount;
  const availability = await availableSlots(
    b.collectionDate,
    outgoing.customer_latitude,
    outgoing.customer_longitude,
  );
  if (!availability.serviceable) throw new HttpError(422, availability.message);
  const slot = availability.slots.find((slot) => slot.id === b.slotId && slot.available);
  if (!slot)
    throw new HttpError(
      422,
      'The selected slot is no longer available. Please choose another time.',
    );
  const order = {
    id,
    kind: 'labs',
    date: new Date().toISOString(),
    status: 'Booking pending',
    paymentStatus: 'Payment to Redcliffe',
    ...pricing,
    pricingVersion: 1,
    couponCode: coupon?.code || null,
    coupon,
    items,
    address: formatAddress(b.address),
    addressSnapshot: structuredClone(b.address),
    deliveryNotes: b.notes,
    collectionDate: b.collectionDate,
    slotId: b.slotId,
    slot: `${b.collectionDate} · ${slot.label}`,
    recipient: {
      id: member.id,
      name: member.name,
      relationship: member.relationship,
      phone: member.phone || '',
      dateOfBirth: member.dateOfBirth,
      age: outgoing.customer_age,
      gender: member.gender,
      address: b.address,
      notes: b.notes,
    },
  };
  await sequelize.transaction(async (transaction) => {
    // Serialize the duplicate check, while allowing distinct bookings for this patient.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: `${customer.id}:${member.id}` },
      transaction,
    });
    const pending = await sequelize.query(
      `SELECT id FROM lab_bookings WHERE customer_id=:customerId AND
      (request_key=:key OR (member_id=:memberId
        AND integration_status IN ('submitting','created','confirming','unknown','confirmation_unknown')
        AND provider_request->>'collection_date'=:collectionDate
        AND provider_request->>'collection_slot'=:slotId
        AND provider_request->'package_code' @> CAST(:codes AS jsonb)
        AND provider_request->'package_code' <@ CAST(:codes AS jsonb))) LIMIT 1`,
      {
        replacements: {
          customerId: customer.id,
          key: b.requestKey,
          memberId: member.id,
          collectionDate: b.collectionDate,
          slotId: String(b.slotId),
          codes: JSON.stringify(outgoing.package_code),
        },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (pending.length)
      throw new HttpError(
        409,
        'These tests for this member at the same date and time are already being processed. View that booking in My Orders.',
      );
    await sequelize.query(
      `INSERT INTO lab_bookings(id,customer_id,request_key,lab_id,member_id,integration_status,request_fingerprint,payload,provider_request)
      VALUES(:id,:customerId,:key,'redcliffe',:memberId,'submitting',:fingerprint,CAST(:payload AS jsonb),CAST(:request AS jsonb))`,
      {
        replacements: {
          id,
          customerId: customer.id,
          key: b.requestKey,
          memberId: member.id,
          fingerprint,
          payload: JSON.stringify(order),
          request: JSON.stringify(outgoing),
        },
        transaction,
      },
    );
  });
  let created;
  try {
    created = await providerRequest(paths.create, { body: outgoing });
  } catch {
    order.status = 'Booking verification pending';
    await updateBooking(id, 'unknown', order, {
      error: 'Provider create response not verified',
    });
    return res.status(202).json(order);
  }
  const providerId = created.booking_id ?? created.pk;
  if (!providerSucceeded(created) || !providerId) {
    const definiteRejection = ['failed', 'failure'].includes(
      String(created.status).toLowerCase(),
    );
    order.status = definiteRejection ? 'Booking failed' : 'Booking verification pending';
    await updateBooking(id, definiteRejection ? 'rejected' : 'unknown', order, {
      response: created,
      error: 'Provider did not return a successful booking ID',
    });
    if (!definiteRejection) return res.status(202).json(order);
    throw new HttpError(
      definiteRejection ? 422 : 502,
      definiteRejection
        ? 'Redcliffe could not accept this booking. Check the patient, test and collection details.'
        : 'Booking response could not be verified. Please check My Orders.',
    );
  }
  order.providerBookingId = String(providerId);
  order.status = 'Confirmation pending';
  const providerTotal = Number(created.discounted_price?.final_total_price);
  if (
    created.discounted_price?.final_total_price !== null &&
    created.discounted_price?.final_total_price !== undefined &&
    Number.isFinite(providerTotal) &&
    providerTotal >= 0
  )
    order.providerTotal = providerTotal;
  // Persist the external ID before attempting confirmation. A failed confirmation must not create a second booking.
  await updateBooking(id, 'confirming', order, {
    providerId: String(providerId),
    response: created,
  });
  let confirmation;
  try {
    confirmation = await providerRequest(paths.confirm, {
      body: { booking_id: providerId, is_confirmed: true },
    });
  } catch {
    await updateBooking(id, 'confirmation_unknown', order, {
      error: 'Provider confirmation response not verified',
    });
    return res.status(202).json(order);
  }
  if (!providerSucceeded(confirmation)) {
    await updateBooking(id, 'confirmation_unknown', order, {
      confirmation,
      error: 'Provider confirmation not accepted',
    });
    return res.status(202).json(order);
  }
  order.status = 'Confirmed';
  await updateBooking(id, 'confirmed', order, { confirmation });
  res.status(201).json(order);
}
