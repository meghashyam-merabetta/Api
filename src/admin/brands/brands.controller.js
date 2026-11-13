import { createEntityImageControllers } from '../../shared/entity-image.controller.js';
import { queueImageUrlCleanup } from '../../shared/image-storage.js';
import { Op } from 'sequelize';
import { Brand, Product } from '../../models/index.js';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
async function find(id, transaction) {
  const brand = await Brand.findByPk(id, {
    transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!brand) throw new HttpError(404, 'Brand not found');
  return brand;
}
export const {
  getImage: getBrandImage,
  uploadImage: uploadBrandImage,
  deleteImage: deleteBrandImage,
} = createEntityImageControllers({
  model: Brand,
  resource: 'brands',
  idParam: 'brandId',
  idField: 'brand_id',
  imageField: 'image_url',
  label: 'Brand',
});
export async function listBrands(req, res) {
  const { limit, offset, search, is_active, all } = req.validatedQuery;
  const where = {};
  if (search) where.brand_name = { [Op.iLike]: `%${search}%` };
  if (is_active !== undefined) where.is_active = is_active === 'true';
  const { rows, count } = await Brand.findAndCountAll({
    where,
    ...(all === 'true' ? {} : { limit, offset }),
    order: [
      ['brand_name', 'ASC'],
      ['brand_id', 'ASC'],
    ],
  });
  res.json({
    data: rows,
    pagination: {
      total: count,
      limit: all === 'true' ? count : limit,
      offset: all === 'true' ? 0 : offset,
      hasMore: all === 'true' ? false : offset + rows.length < count,
    },
  });
}
export async function getBrand(req, res) {
  return res.json({ data: await find(req.validatedParams.brandId) });
}
export async function createBrand(req, res) {
  return res.status(201).json({ data: await Brand.create(req.validated) });
}
export async function updateBrand(req, res) {
  const row = await sequelize.transaction(async (transaction) => {
    const brand = await find(req.validatedParams.brandId, transaction);
    if (
      Object.hasOwn(req.validated, 'image_url') &&
      req.validated.image_url !== brand.image_url
    ) {
      await queueImageUrlCleanup(brand.image_url, transaction);
    }
    return brand.update(req.validated, { transaction });
  });
  res.json({ data: row });
}
export async function deleteBrand(req, res) {
  await sequelize.transaction(async (transaction) => {
    const brand = await find(req.validatedParams.brandId, transaction);
    if (await Product.count({ where: { brand_id: brand.brand_id }, transaction }))
      throw new HttpError(409, 'Cannot delete a brand assigned to products');
    await queueImageUrlCleanup(brand.image_url, transaction);
    await brand.destroy({ transaction });
  });
  res.status(204).end();
}
