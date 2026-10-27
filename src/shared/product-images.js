export const MAX_PRODUCT_IMAGES = 10;
export const PRODUCT_IMAGE_SLOTS = Array.from(
  { length: MAX_PRODUCT_IMAGES },
  (_, index) => String.fromCharCode(97 + index),
);
