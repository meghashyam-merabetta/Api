import { createHash, randomBytes } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { gatewayRequest, paymentUrl, requireGateway } from '../hdfc/client.js';
import { resolveCoupon } from '../coupons/routes.js';
import { couponDiscount } from '../coupons/pricing.js';
export function paise(value) {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new HttpError(422, 'Invalid amount');
  const [a, b = ''] = text.split('.');
  const n = Number(a) * 100 + Number(b.padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw new HttpError(422, 'Invalid amount');
  return n;
}
export function verifiedStatus(row, data) {
  if (
    data.order_id !== row.id ||
    data.merchant_id !== env.HDFC_MERCHANT_ID ||
    data.currency !== 'INR' ||
    paise(data.amount) !== Number(row.amount_paise)
  )
    throw new HttpError(
      502,
      'Payment details could not be verified. Please contact support.',
    );
  return data.status === 'CHARGED'
    ? 'CHARGED'
    : ['AUTHENTICATION_FAILED', 'AUTHORIZATION_FAILED', 'JUSPAY_DECLINED'].includes(
          data.status,
        )
      ? 'FAILED'
      : 'PENDING';
}
export async function findOrder(id, customer) {
  const [row] = await sequelize.query(
    'SELECT * FROM orders WHERE id=:id' + (customer ? ' AND customer_id=:customer' : ''),
    { replacements: { id, customer }, type: QueryTypes.SELECT },
  );
  if (!row) throw new HttpError(404, 'Order not found');
  return row;
}
export async function syncOrder(row) {
  if (row.payment_status === 'CHARGED') return row;
  const data = await gatewayRequest('/orders/' + row.id, row.customer_id);
  const status = verifiedStatus(row, data);
  const url = paymentUrl(data.payment_links?.web);
  await sequelize.query(
    `UPDATE orders SET payment_status=:status,transaction_id=:txn,payment_url=COALESCE(:url,payment_url),payload=jsonb_set(jsonb_set(payload,'{status}',to_jsonb(CAST(:label AS text))),'{paymentStatus}',to_jsonb(CAST(:payment AS text))),updated_at=now() WHERE id=:id AND payment_status<>'CHARGED'`,
    {
      replacements: {
        id: row.id,
        status,
        txn: typeof data.txn_id === 'string' ? data.txn_id : null,
        url,
        label:
          status === 'CHARGED'
            ? 'Processing'
            : status === 'FAILED'
              ? 'Payment failed'
              : 'Payment pending',
        payment:
          status === 'CHARGED' ? 'Paid' : status === 'FAILED' ? 'Failed' : 'Pending',
      },
    },
  );
  return findOrder(row.id, row.customer_id);
}
export function orderView(row) {
  return {
    ...row.payload,
    paymentUrl: row.payment_status === 'CHARGED' ? null : paymentUrl(row.payment_url),
  };
}
export async function createOrder(req, res) {
  requireGateway();
  const b = req.validated;
  const customer = req.credential;
  if (!customer.phone || !customer.email)
    throw new HttpError(
      422,
      'Add your mobile number and email to your profile before payment.',
    );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        ...b,
        requestKey: undefined,
        items: [...b.items].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest('hex');
  let row;
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: 'product-order:' + customer.id },
      transaction,
    });
    const [old] = await sequelize.query(
      "SELECT * FROM orders WHERE customer_id=:customer AND (request_key=:key OR (fingerprint=:fingerprint AND payment_status<>'CHARGED')) ORDER BY (request_key=:key) DESC LIMIT 1",
      {
        replacements: { customer: customer.id, key: b.requestKey, fingerprint },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new HttpError(409, 'This checkout request contains different details.');
      row = old;
      return;
    }
    const items = [];
    let subtotal = 0;
    for (const item of b.items) {
      const [product] = await sequelize.query(
        'SELECT data FROM product_catalog WHERE id=:id AND active',
        { replacements: { id: item.id }, type: QueryTypes.SELECT, transaction },
      );
      if (!product) throw new HttpError(422, 'A product is no longer available.');
      const unit = paise(product.data.price);
      subtotal += unit * item.quantity;
      items.push({ ...item, snapshot: product.data });
    }
    const coupon = await resolveCoupon(b.couponCode, 'products', transaction);
    const discount = couponDiscount(subtotal, coupon);
    const delivery = subtotal >= 49900 ? 0 : 4000;
    const total = subtotal - discount + delivery;
    const id = 'MB' + randomBytes(9).toString('hex');
    const payload = {
      id,
      kind: 'products',
      date: new Date().toISOString(),
      status: 'Payment pending',
      paymentStatus: 'Pending',
      total: total / 100,
      subtotal: subtotal / 100,
      discount: discount / 100,
      couponCode: coupon?.code || null,
      coupon,
      delivery: delivery / 100,
      items,
      address: [
        b.address.line1,
        b.address.line2,
        b.address.city,
        b.address.state,
        b.address.postalCode,
      ]
        .filter(Boolean)
        .join(', '),
      deliveryNotes: b.notes,
      orderedBy: {
        name:
          customer.name ||
          [customer.firstName, customer.lastName].filter(Boolean).join(' '),
        phone: customer.phone,
        email: customer.email,
      },
      slot: '',
      deliveryAddress: b.address,
    };
    await sequelize.query(
      'INSERT INTO orders(id,customer_id,request_key,fingerprint,amount_paise,payload) VALUES(:id,:customer,:key,:fingerprint,:amount,CAST(:payload AS jsonb))',
      {
        replacements: {
          id,
          customer: customer.id,
          key: b.requestKey,
          fingerprint,
          amount: total,
          payload: JSON.stringify(payload),
        },
        transaction,
      },
    );
    for (const item of items)
      await sequelize.query(
        'INSERT INTO order_details(order_id,product_id,quantity,unit_price_paise,snapshot) VALUES(:id,:product,:qty,:unit,CAST(:snapshot AS jsonb))',
        {
          replacements: {
            id,
            product: item.id,
            qty: item.quantity,
            unit: paise(item.snapshot.price),
            snapshot: JSON.stringify(item.snapshot),
          },
          transaction,
        },
      );
    row = {
      id,
      customer_id: customer.id,
      payload,
      amount_paise: total,
      payment_status: 'NEW',
      session_state: 'created',
    };
  });
  if (row.payment_status === 'CHARGED' || row.payment_url)
    return res.json(orderView(row));
  const claim = await sequelize.query(
    "UPDATE orders SET session_state='submitting',updated_at=now() WHERE id=:id AND session_state='created' RETURNING id",
    { replacements: { id: row.id }, type: QueryTypes.SELECT },
  );
  if (!claim.length) return res.status(202).json(orderView(row));
  try {
    const result = await gatewayRequest('/session', customer.id, {
      order_id: row.id,
      amount: (Number(row.amount_paise) / 100).toFixed(2),
      customer_id: customer.id,
      customer_email: customer.email,
      customer_phone: customer.phone,
      payment_page_client_id: env.HDFC_CLIENT_ID,
      action: 'paymentPage',
      currency: 'INR',
      return_url: env.HDFC_RETURN_URL,
      description: 'Merabetta product order',
      first_name: customer.firstName || '',
      last_name: customer.lastName || '',
    });
    const url = paymentUrl(result.payment_links?.web);
    if (result.order_id !== row.id || !url) throw Error('Invalid gateway session');
    await sequelize.query(
      "UPDATE orders SET session_state='ready',payment_url=:url,updated_at=now() WHERE id=:id",
      { replacements: { id: row.id, url } },
    );
    row.payment_url = url;
  } catch {
    await sequelize.query(
      "UPDATE orders SET session_state='unknown',last_error='Gateway session unverified',updated_at=now() WHERE id=:id",
      { replacements: { id: row.id } },
    );
  }
  res.status(row.payment_url ? 201 : 202).json(orderView(row));
}
export async function getOrder(req, res) {
  const row = await findOrder(req.validatedParams.id, req.credential.id);
  res.json(orderView(await syncOrder(row)));
}
export async function listOrders(req, res) {
  const rows = await sequelize.query(
    'SELECT * FROM orders WHERE customer_id=:id ORDER BY created_at DESC',
    { replacements: { id: req.credential.id }, type: QueryTypes.SELECT },
  );
  res.json({ data: rows.map(orderView) });
}
