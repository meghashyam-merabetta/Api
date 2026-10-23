const money = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Math.round(Number(value) * 100) / 100;
const rounded = value => Math.round(value * 100) / 100;
const sum = (items, key) => items.length && items.every(item => item[key] !== null) ? rounded(items.reduce((total, item) => total + item[key], 0)) : null;

export function orderingSummary({ payload = {}, ...row }) {
  const groups = [
    { items: payload.items, patientName: payload.recipient?.name || null },
    ...(Array.isArray(payload.additionalMembers) ? payload.additionalMembers.map(member => ({ items: member.items, patientName: member.name || null })) : []),
  ];
  const items = groups.flatMap(group => (Array.isArray(group.items) ? group.items : []).map(item => {
    const snapshot = item.snapshot || {};
    const quantity = Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : null;
    const unitMrp = money(snapshot.mrp), unitPrice = money(snapshot.price);
    const lineMrp = quantity !== null && unitMrp !== null ? rounded(quantity * unitMrp) : null;
    const linePrice = quantity !== null && unitPrice !== null ? rounded(quantity * unitPrice) : null;
    return { id: item.id || null, name: snapshot.name || item.name || null, patientName: group.patientName,
      quantity, unitMrp, unitPrice, lineMrp, linePrice,
      offerDiscount: lineMrp !== null && linePrice !== null ? rounded(Math.max(0, lineMrp - linePrice)) : null };
  }));
  const totalMrp = sum(items, 'lineMrp');
  const subtotal = money(payload.subtotal) ?? sum(items, 'linePrice');
  const couponCode = payload.couponCode || payload.coupon?.code || null;
  const couponDiscount = money(payload.discount) ?? (couponCode ? null : 0);
  const priceAfterCoupon = subtotal !== null && couponDiscount !== null ? rounded(subtotal - couponDiscount) : null;
  const isLab = payload.kind === 'labs' || !!row.labId;
  const collectionCharges = isLab ? money(payload.collection) : 0;
  const deliveryCharges = isLab ? 0 : money(payload.delivery);
  const charges = collectionCharges !== null && deliveryCharges !== null ? rounded(collectionCharges + deliveryCharges) : null;
  const finalAmount = money(row.total);
  return { ...row, total: finalAmount, items, itemNames: items.map(item => item.name || item.id || 'Unknown').join(' | '),
    itemCount: items.length, totalQuantity: items.every(item => item.quantity !== null) ? items.reduce((n, item) => n + item.quantity, 0) : null,
    totalMrp, offerDiscount: totalMrp !== null && subtotal !== null ? rounded(Math.max(0, totalMrp - subtotal)) : null,
    subtotal, couponCode, couponPercent: money(payload.coupon?.percent),
    couponMaxDiscount: payload.coupon?.max_discount_paise === undefined ? null : money(Number(payload.coupon.max_discount_paise) / 100),
    couponDiscount, priceAfterCoupon, collectionCharges, deliveryCharges, charges, finalAmount };
}
