import { readPricingSettings, chargeBelow } from '../pricing/settings.js';
import { formatAddress } from '../../shared/address.js';
import { createHash } from 'node:crypto';
import { nextOrderId } from './order-number.js';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { gatewayRequest, paymentUrl, requireGateway } from '../hdfc/client.js';
import { resolveCoupon } from '../coupons/routes.js';
import { couponDiscount } from '../coupons/pricing.js';
import { reserveStock, settleStock } from './inventory.js';
import { sellableProduct } from '../products/catalog.js';
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
  // A sandbox/simulated CHARGED response is not proof of a real customer payment.
  if (data.status === 'CHARGED' && !isLivePayment(row, data)) return 'FAILED';
  return data.status === 'CHARGED'
    ? 'CHARGED'
    : ['AUTHENTICATION_FAILED', 'AUTHORIZATION_FAILED', 'JUSPAY_DECLINED'].includes(
          data.status,
        )
      ? 'FAILED'
      : 'PENDING';
}
export function isLivePayment(row, data) {
  const gateway = String(data.txn_detail?.gateway || data.gateway || '').trim().toUpperCase();
  const test = value => value === true || value === 'true' || value === 1 || value === '1';
  return env.HDFC_ENVIRONMENT === 'production'
    && row.payload?.paymentEnvironment !== 'sandbox'
    && !String(row.payment_url || '').includes('hdfcuat.')
    && !!gateway && !['DUMMY', 'TEST', 'SANDBOX'].includes(gateway)
    && String(data.gateway_id) !== '100' && String(data.txn_detail?.gateway_id) !== '100'
    && !test(data.test_mode) && !test(data.txn_detail?.test_mode)
    && typeof data.txn_id === 'string' && !!data.txn_id.trim();
}
// Called under the checkout row lock, in the same transaction as stock settlement.
async function promoteCheckout(id, transaction) {
  await sequelize.query(
    `INSERT INTO orders SELECT * FROM product_checkouts WHERE id=:id AND payment_status IN ('CHARGED','COD')
     ON CONFLICT(id) DO UPDATE SET payment_status=EXCLUDED.payment_status,stock_state=EXCLUDED.stock_state,
       payload=EXCLUDED.payload,payment_url=EXCLUDED.payment_url,transaction_id=EXCLUDED.transaction_id,updated_at=EXCLUDED.updated_at`,
    { replacements: { id }, transaction },
  );
  const [checkout] = await sequelize.query('SELECT payload FROM product_checkouts WHERE id=:id', { replacements: { id }, type: QueryTypes.SELECT, transaction });
  for (const item of checkout.payload.items) {
    await sequelize.query(
      'INSERT INTO order_details(order_id,product_id,quantity,unit_price_paise,snapshot) VALUES(:id,:product,:qty,:unit,CAST(:snapshot AS jsonb)) ON CONFLICT(order_id,product_id) DO NOTHING',
      { replacements: { id, product: item.id, qty: item.quantity, unit: paise(item.snapshot.price), snapshot: JSON.stringify(item.snapshot) }, transaction },
    );
  }
}
export async function findOrder(id, customer) {
  const [row] = await sequelize.query(
    'SELECT * FROM product_checkouts WHERE id=:id' + (customer ? ' AND customer_id=:customer' : ''),
    { replacements: { id, customer }, type: QueryTypes.SELECT },
  );
  if (!row) throw new HttpError(404, 'Order not found');
  return row;
}
export async function syncOrder(row) {
  if (row.payment_status === 'COD') return row;
  if (row.payment_status === 'CHARGED') return row;
  const data = await gatewayRequest('/orders/' + row.id, row.customer_id);
  await applyPaymentStatus(row.id, data);

  return findOrder(row.id, row.customer_id);
}
export async function applyPaymentStatus(id, data) {
  return sequelize.transaction(async (transaction) => {
    const [row] = await sequelize.query('SELECT * FROM product_checkouts WHERE id=:id FOR UPDATE', {
      replacements: { id },
      type: QueryTypes.SELECT,
      transaction,
    });
    if (!row) throw new HttpError(404, 'Order not found');
    if (row.payment_status === 'COD') return row;
    const status = verifiedStatus(row, data);
    if (row.payment_status === 'CHARGED') return row;
    let stock = row.stock_state;
    if (status === 'CHARGED') {
      if (stock === 'released') {
        try {
          await reserveStock(row.id, row.payload.items, transaction);
          stock = 'reserved';
        } catch (error) {
          if (error.status !== 409) throw error;
          stock = 'review';
        }
      }
      if (stock === 'reserved') {
        await settleStock(row.id, true, transaction);
        stock = 'deducted';
      }
      // Old orders predate inventory tracking: never silently deduct them twice.
      else if (stock === 'legacy') stock = 'review';
    } else if (status === 'FAILED' && stock === 'reserved') {
      await settleStock(row.id, false, transaction);
      stock = 'released';
    }
    // A stale pending response must not revive an already failed payment link.
    if (row.payment_status === 'FAILED' && status === 'PENDING') return row;
    const label =
      status === 'CHARGED'
        ? stock === 'review'
          ? 'Payment received - stock review'
          : 'Processing'
        : status === 'FAILED'
          ? 'Payment failed'
          : 'Payment pending';
    const payment =
      status === 'CHARGED' ? 'Paid' : status === 'FAILED' ? 'Failed' : 'Pending';
    const payload = { ...row.payload, status: data.status === 'CHARGED' && status === 'FAILED' ? 'Payment not verified as live' : label, paymentStatus: payment };
    const url =
      status === 'FAILED' || status === 'CHARGED'
        ? null
        : paymentUrl(data.payment_links?.web) || row.payment_url;
    await sequelize.query(
      'UPDATE product_checkouts SET payment_status=:status,stock_state=:stock,transaction_id=:txn,payment_url=:url,payload=CAST(:payload AS jsonb),payment_checked_at=now(),updated_at=now() WHERE id=:id',
      {
        replacements: {
          id,
          status,
          stock,
          txn: typeof data.txn_id === 'string' ? data.txn_id : null,
          url,
          payload: JSON.stringify(payload),
        },
        transaction,
      },
    );
    if (status === 'CHARGED') await promoteCheckout(id, transaction);
    return {
      ...row,
      payment_status: status,
      stock_state: stock,
      payload,
      payment_url: url,
    };
  });
}
export function orderView(row) {
  return {
    ...row.payload,
    orderNumber: row.order_number || row.id,
    paymentReturnUrl: env.HDFC_RETURN_URL || null,
    paymentUrl: ['CHARGED', 'FAILED'].includes(row.payment_status)
      ? null
      : paymentUrl(row.payment_url),
  };
}
export async function createOrder(req, res) {
  const b = req.validated;
  const cod = b.paymentMethod === 'cod';
  if (!cod) requireGateway();
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
      "SELECT * FROM product_checkouts WHERE customer_id=:customer AND (request_key=:key OR (fingerprint=:fingerprint AND payment_status NOT IN ('CHARGED','FAILED','COD'))) ORDER BY (request_key=:key) DESC LIMIT 1",
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
      const product = await sellableProduct(item.id, item.quantity, transaction);
      const unit = paise(product.price);
      subtotal += unit * item.quantity;
      items.push({ ...item, snapshot: product });
    }
    const coupon = await resolveCoupon(b.couponCode, 'products', transaction);
    const discount = couponDiscount(subtotal, coupon);
    const pricingSettings = await readPricingSettings(transaction);
    const delivery = chargeBelow(subtotal, pricingSettings.product_delivery_below_paise, pricingSettings.product_delivery_charge_paise);
    const handling = chargeBelow(subtotal, pricingSettings.product_handling_below_paise, pricingSettings.product_handling_charge_paise);
    const total = subtotal - discount + delivery + handling;
    const id = await nextOrderId(transaction);
    const payload = {
      id,
      kind: 'products',
      date: new Date().toISOString(),
      status: cod ? 'Processing' : 'Payment pending',
      paymentMethod: cod ? 'cod' : 'online',
      paymentEnvironment: cod ? null : env.HDFC_ENVIRONMENT,
      paymentStatus: cod ? 'Cash on delivery' : 'Pending',
      total: total / 100,
      subtotal: subtotal / 100,
      discount: discount / 100,
      couponCode: coupon?.code || null,
      coupon,
      delivery: delivery / 100,
      handling: handling / 100,
      pricingSettings,
      items,
      address: formatAddress(b.address),
      addressSnapshot: structuredClone(b.address),
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
      'INSERT INTO product_checkouts(id,order_number,customer_id,request_key,fingerprint,amount_paise,payload,stock_state) VALUES(:id,:id,:customer,:key,:fingerprint,:amount,CAST(:payload AS jsonb),:stock)',
      {
        replacements: {
          id,
          customer: customer.id,
          key: b.requestKey,
          fingerprint,
          amount: total,
          stock: 'reserved',
          payload: JSON.stringify(payload),
        },
        transaction,
      },
    );
    await reserveStock(id, items, transaction);
    if (cod) {
      await settleStock(id, true, transaction);
      await sequelize.query("UPDATE product_checkouts SET payment_status='COD',session_state='not_required',stock_state='deducted' WHERE id=:id", { replacements: { id }, transaction });
    }
    if (cod) await promoteCheckout(id, transaction);
    row = {
      id,
      customer_id: customer.id,
      payload,
      amount_paise: total,
      payment_status: cod ? 'COD' : 'NEW',
      session_state: 'created',
    };
  });
  if (['CHARGED', 'FAILED', 'COD'].includes(row.payment_status) || row.payment_url)
    return res.json(orderView(row));
  // A previous timeout may have created a gateway session. Check it before retrying.
  if (row.session_state === 'unknown') {
    try {
      row = await syncOrder(row);
      if (row.payment_url || ['CHARGED', 'FAILED'].includes(row.payment_status))
        return res.json(orderView(row));
      throw new HttpError(503, 'Payment is still being verified. Your cart is unchanged. Please try again later.');
    } catch (error) {
      if (error.gatewayStatus !== 404) throw error;
      await sequelize.query("UPDATE product_checkouts SET session_state='created',last_error=NULL WHERE id=:id AND session_state='unknown'", { replacements: { id: row.id } });
    }
  }
  const claim = await sequelize.query(
    "UPDATE product_checkouts SET session_state='submitting',updated_at=now() WHERE id=:id AND session_state='created' RETURNING id",
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
      "UPDATE product_checkouts SET session_state='ready',payment_url=:url,updated_at=now() WHERE id=:id",
      { replacements: { id: row.id, url } },
    );
    row.payment_url = url;
  } catch (error) {
    const rejected = [401, 403].includes(error.gatewayStatus);
    await sequelize.query(
      'UPDATE product_checkouts SET session_state=:state,last_error=:error,updated_at=now() WHERE id=:id',
      { replacements: { id: row.id, state: rejected ? 'created' : 'unknown', error: rejected ? 'Gateway authentication rejected' : 'Gateway session unverified' } },
    );
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Could not open HDFC payment. Your cart is unchanged. Please try again later.');
  }
  row = await findOrder(row.id, customer.id);
  res.status(row.payment_url ? 201 : 202).json(orderView(row));
}
export async function getOrder(req, res) {
  const row = await findOrder(req.validatedParams.id, req.credential.id);
  res.json(orderView(await syncOrder(row)));
}
export async function listOrders(req, res) {
  const rows = await sequelize.query(
    "SELECT * FROM orders WHERE customer_id=:id AND payment_status IN ('CHARGED','COD') ORDER BY created_at DESC",
    { replacements: { id: req.credential.id }, type: QueryTypes.SELECT },
  );
  res.json({ data: rows.map(orderView) });
}