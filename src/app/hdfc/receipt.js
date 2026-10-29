export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export function receiptHtml(row, { unverified = false, download = false } = {}) {
  const paid = !unverified && row.payment_status === 'CHARGED';
  const failed = !unverified && row.payment_status === 'FAILED';
  const test = row.payload?.paymentEnvironment === 'sandbox' || row.payload?.isTestOrder === true;
  const title = paid ? 'Payment successful' : failed ? 'Payment unsuccessful' : 'Payment verification pending';
  const amount = (Number(row.amount_paise) / 100).toFixed(2);
  const e = escapeHtml;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Merabetta</title>
  <style>body{font:16px system-ui,sans-serif;background:#f7f2fa;color:#30223d;margin:0;padding:24px}main{max-width:560px;margin:40px auto;background:white;padding:28px;border:1px solid #e5d6ec;border-radius:18px}h1{color:${paid ? '#18724b' : '#77409a'};font-size:28px}dl{display:grid;grid-template-columns:1fr 1fr;gap:16px}dd{margin:0;overflow-wrap:anywhere;font-weight:600}dt{color:#65586f}.test{background:#fff0df;padding:12px;border-radius:8px}a{display:inline-block;margin:8px 12px 8px 0;color:#77409a;padding:10px;border:1px solid;border-radius:8px}.note{font-size:13px;color:#65586f}@media print{nav{display:none}body{padding:0;background:white}main{border:0;margin:0}}</style></head><body><main>
  <p>Merabetta · Vision55 Megacare Private Limited</p><h1>${title}</h1>
  ${test ? '<p class="test">UAT TEST TRANSACTION — No goods or services will be supplied. This is not proof of a live payment.</p>' : ''}
  <dl><dt>Order number</dt><dd>${e(row.id)}</dd><dt>Amount</dt><dd>INR ${e(amount)}</dd><dt>Payment status</dt><dd>${paid ? 'Success' : failed ? 'Failed' : 'Pending'}</dd>
  ${paid ? `<dt>Receipt number</dt><dd>R${e(row.id)}</dd><dt>Transaction reference</dt><dd>${e(row.transaction_id)}</dd>` : ''}</dl>
  <p>${paid ? (test ? 'Your test payment has been verified successfully.' : 'Your payment has been verified successfully.') : failed ? 'Payment was not successful. Check your order before trying again.' : 'We cannot confirm payment yet. If money was debited, do not pay again until the status is confirmed.'}</p>
  <p class="note">${paid ? 'Payment receipt, not a tax invoice. Save or print this page for your records.' : 'Use Check payment status to obtain the latest verified result.'}</p>
  ${download ? '' : `<nav><a href="?">Check payment status</a>${paid ? '<a href="?download=1">Download receipt</a>' : ''}<a href="merabetta://payment-return">Return to Merabetta</a></nav>`}
  <p class="note">Support: +91 89991 88267</p></main></body></html>`;
}
