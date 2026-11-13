import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { models } from '../models/index.js';

export async function productImages(productId, transaction) {
  return sequelize.query(
    `SELECT * FROM (
    SELECT id,product_id,image_url,s3_key,alt_text,sort_order,is_primary,created_at,FALSE AS inherited FROM product_images WHERE product_id=:id
    UNION ALL
    SELECT p.id,l.product_id,p.image_url,p.s3_key,p.alt_text,l.sort_order,l.is_primary,p.created_at,TRUE AS inherited
      FROM independent_product_images l JOIN product_images p ON p.id=l.source_image_id WHERE l.product_id=:id
    ) images ORDER BY is_primary DESC,sort_order,id`,
    { replacements: { id: productId }, type: QueryTypes.SELECT, transaction },
  );
}
export async function clearPrimaryImages(productId, transaction) {
  await models.productImage.update(
    { is_primary: false },
    { where: { product_id: productId, is_primary: true }, transaction },
  );
  await sequelize.query(
    'UPDATE independent_product_images SET is_primary=FALSE WHERE product_id=:id AND is_primary',
    { replacements: { id: productId }, transaction },
  );
}
export async function primaryImage(productId, image, transaction) {
  await clearPrimaryImages(productId, transaction);
  if (image.inherited)
    await sequelize.query(
      'UPDATE independent_product_images SET is_primary=TRUE WHERE product_id=:product AND source_image_id=:image',
      { replacements: { product: productId, image: image.id }, transaction },
    );
  else
    await models.productImage.update(
      { is_primary: true },
      { where: { id: image.id, product_id: productId }, transaction },
    );
}
export async function unlinkImage(productId, imageId, transaction) {
  await sequelize.query(
    'DELETE FROM independent_product_images WHERE product_id=:product AND source_image_id=:image',
    { replacements: { product: productId, image: imageId }, transaction },
  );
}
