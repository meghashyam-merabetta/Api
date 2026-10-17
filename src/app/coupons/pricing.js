export function couponDiscount(subtotal, coupon) {
  if (!coupon) return 0;
  return Math.min(
    subtotal,
    Number(coupon.max_discount_paise),
    Math.round((subtotal * Number(coupon.percent)) / 100),
  );
}
export function labPricing(subtotal, coupon) {
  const discount = couponDiscount(subtotal, coupon);
  const collection = subtotal - discount < 59900 ? 15000 : 0;
  return {
    subtotal: subtotal / 100,
    discount: discount / 100,
    collection: collection / 100,
    total: (subtotal - discount + collection) / 100,
  };
}
