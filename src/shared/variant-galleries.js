import { models } from '../models/index.js';
import { productImages } from './independent-images.js';

export const galleryOrder = [
  ['is_primary', 'DESC'],
  ['sort_order', 'ASC'],
  ['id', 'ASC'],
];
export async function defaultGallery(product, transaction) {
  return product.inventory_managed
    ? productImages(product.product_id, transaction)
    : models.productImage.findAll({
        where: { product_id: product.product_id },
        order: galleryOrder,
        transaction,
      });
}
export async function variantGallery(variant, product, transaction, inheritedImages) {
  const custom = await models.variantImage.findAll({
    where: { variant_id: variant.id },
    order: galleryOrder,
    transaction,
  });
  const images = variant.use_product_images
    ? (inheritedImages ?? (await defaultGallery(product, transaction)))
    : custom;
  return {
    product_id: String(product.product_id),
    variant_id: String(variant.id),
    use_product_images: variant.use_product_images,
    effective_source: variant.use_product_images ? 'product' : 'variant',
    custom_images: custom,
    effective_images: images,
    primary_image: images.find((image) => image.is_primary) ?? images[0] ?? null,
  };
}
export async function variantWithGallery(variant, product, transaction, inheritedImages) {
  return {
    ...variant.toJSON(),
    gallery: await variantGallery(variant, product, transaction, inheritedImages),
  };
}
