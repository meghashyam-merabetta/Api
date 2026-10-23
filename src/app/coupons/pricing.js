export function couponDiscount(subtotal, coupon) {
  if (!coupon) return 0;
  return Math.min(
    subtotal,
    Number(coupon.max_discount_paise),
    Math.ceil((subtotal * Number(coupon.percent)) / 10000) * 100,
  );
}
export function labPricing(subtotal, coupon, settings) {
  const discount = couponDiscount(subtotal, coupon);
  const collection = subtotal - discount < settings.lab_collection_below_paise ? settings.lab_collection_charge_paise : 0;
  return {
    subtotal: subtotal / 100,
    discount: discount / 100,
    collection: collection / 100,
    total: (subtotal - discount + collection) / 100,
  };
}
