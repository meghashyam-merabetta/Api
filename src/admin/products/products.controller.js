import { auditContext } from '../../shared/catalog-audit.js';
import {
  configurationLink,
  configurationStock,
  setConfigurationStock,
  lockConfigurationGroup,
  refreshGroupConfigurations,
  archiveConfigurations,
} from '../../shared/configuration-products.js';
import {
  variantGallery,
  galleryForConfigurationProduct,
} from '../../shared/variant-galleries.js';
import { env } from '../../config/env.js';
import { variantWithGallery } from '../../shared/variant-galleries.js';
import { MAX_PRODUCT_IMAGES } from '../../shared/product-images.js';
import {
  catalogMutation,
  sendMutation,
  fingerprint,
} from '../../shared/catalog-idempotency.js';
import {
  stageImage,
  reserveImage,
  imageUrl,
  queueImageCleanup,
  finishImageCleanup,
} from '../../shared/image-storage.js';
import {
  publishProductCatalog,
  deactivateProductCatalog,
} from '../../shared/catalog-publisher.js';
import { normalizePricing, storedCatalogFields } from '../../shared/catalog-fields.js';
import { Op, literal } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { productImageUpload } from '../../shared/image_upload.js';

const Product = models.product;
const Category = models.category;
const ProductCategory = models.productCategory;

async function findProduct(productId, transaction) {
  if (transaction) await lockConfigurationGroup(productId, transaction);
  const product = await Product.findByPk(productId, {
    transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });

  if (!product) {
    throw new HttpError(404, 'Product not found');
  }

  return product;
}

async function validateBrand(brandId, transaction) {
  if (brandId === null || brandId === undefined) return;
  const brand = await models.brand.findByPk(brandId, {
    transaction,
    lock: transaction.LOCK.SHARE,
  });
  if (!brand) throw new HttpError(400, 'Brand not found');
}

function catalogIncludes() {
  return [
    { model: models.brand, as: 'brand' },
    {
      model: models.productVariant,
      as: 'variants',
      separate: true,
      order: [
        ['sku', 'ASC'],
        ['id', 'ASC'],
      ],
    },
    {
      model: models.productImage,
      as: 'images',
      separate: true,
      order: [
        ['is_primary', 'DESC'],
        ['sort_order', 'ASC'],
        ['id', 'ASC'],
      ],
    },
  ];
}

async function validateCategories(categoryIds, transaction) {
  const ids = [...new Set(categoryIds.map(String))];

  if (ids.length === 0) {
    return;
  }

  const categories = await Category.findAll({
    where: {
      category_id: { [Op.in]: ids },
    },
    attributes: ['category_id'],
    transaction,
  });

  if (categories.length !== ids.length) {
    throw new HttpError(400, 'One or more categories were not found');
  }
}

async function replaceProductCategories(
  productId,
  categoryIds,
  primaryCategoryId,
  transaction,
) {
  const uniqueIds = [...new Set(categoryIds.map(String))];

  await validateCategories(uniqueIds, transaction);

  if (
    primaryCategoryId !== null &&
    primaryCategoryId !== undefined &&
    !uniqueIds.includes(String(primaryCategoryId))
  ) {
    throw new HttpError(400, 'The primary category must be included in category_ids');
  }

  await ProductCategory.destroy({
    where: { product_id: productId },
    transaction,
  });

  if (uniqueIds.length > 0) {
    await ProductCategory.bulkCreate(
      uniqueIds.map((categoryId) => ({
        product_id: productId,
        category_id: categoryId,
        is_primary:
          primaryCategoryId !== null &&
          primaryCategoryId !== undefined &&
          String(categoryId) === String(primaryCategoryId),
      })),
      { transaction },
    );
  }
}

// ======================================================
// PRODUCT CRUD
// ======================================================

export async function listProducts(req, res) {
  const {
    limit = 20,
    offset = 0,
    category_id,
    search,
    product_status,
    brand_id,
    sort_by = 'product_id',
    sort_order = 'asc',
  } = req.validatedQuery;

  const where = {};
  if (env.CONFIGURATION_PRODUCTS_ENABLED) {
    if (req.validatedQuery.view === 'individual') {
      where.is_configuration_group = false;
      where.inventory_managed = true;
    } else
      where[Op.and] = literal(
        'NOT EXISTS (SELECT 1 FROM product_configuration_links l WHERE l.product_id="Product"."id")',
      );
  }

  if (search) {
    where[Op.or] = [
      { product_name: { [Op.iLike]: `%${search}%` } },
      { product_code: { [Op.iLike]: `%${search}%` } },
      { sku: { [Op.iLike]: `%${search}%` } },
      { barcode: { [Op.iLike]: `%${search}%` } },
      { manufacturer_sku: { [Op.iLike]: `%${search}%` } },
      { model_number: { [Op.iLike]: `%${search}%` } },
      { keywords: { [Op.contains]: [search] } },
    ];
  }

  if (product_status) {
    where.product_status = product_status;
  }

  if (brand_id !== undefined) where.brand_id = brand_id;

  const include = [
    ...catalogIncludes(),
    {
      model: Category,
      as: 'categories',
      through: { attributes: ['is_primary'] },
      required: category_id !== undefined,
      ...(category_id !== undefined ? { where: { category_id } } : {}),
    },
  ];

  const { rows, count } = await Product.findAndCountAll({
    where,
    include,
    distinct: true,
    limit,
    offset,
    order: [
      [sort_by, sort_order.toUpperCase()],
      ...(sort_by === 'product_id' ? [] : [['product_id', 'ASC']]),
    ],
  });

  res.json({
    data: await Promise.all(
      rows.map(async (r) => {
        const result = r.toJSON();
        if (env.CONFIGURATION_PRODUCTS_ENABLED && r.inventory_managed) {
          result.stock_quantity = await configurationStock(r.product_id);
          const gallery = await galleryForConfigurationProduct(r.product_id);
          if (gallery) result.images = gallery.effective_images;
        }
        return result;
      }),
    ),

    pagination: {
      total: count,
      limit,
      offset,
      hasMore: offset + rows.length < count,
    },
  });
}

export async function getProduct(req, res) {
  const product = await findProduct(req.validatedParams.productId);
  if (env.CONFIGURATION_PRODUCTS_ENABLED && product.inventory_managed) {
    const link = await configurationLink({ productId: product.product_id });
    let gallery;
    if (link) {
      const group = await Product.findByPk(link.group_product_id);
      const variant = await models.productVariant.findByPk(link.variant_id);
      if (!group || !variant)
        throw new HttpError(404, 'Product configuration is unavailable');
      gallery = await variantGallery(variant, group);
    }
    const detail = await Product.findByPk(product.product_id, {
      include: [
        ...catalogIncludes(),
        { model: Category, as: 'categories', through: { attributes: ['is_primary'] } },
      ],
    });
    return res.json({
      data: {
        ...detail.toJSON(),
        stock_quantity: await configurationStock(product.product_id),
        individual_product_id: String(product.product_id),
        group_product_id: link ? String(link.group_product_id) : null,
        source_variant_id: link ? String(link.variant_id) : null,
        variants: [],
        ...(gallery ? { gallery, images: gallery.effective_images } : {}),
      },
    });
  }

  const result = await Product.findByPk(product.product_id, {
    include: [
      {
        model: Category,
        as: 'categories',
        through: { attributes: ['is_primary'] },
      },
      ...catalogIncludes(),
    ],
  });

  for (const variant of result.variants ?? []) {
    const enriched = await variantWithGallery(variant, result);
    for (const key of [
      'gallery',
      'individual_product_id',
      'group_product_id',
      'stock_quantity',
    ])
      if (Object.hasOwn(enriched, key)) variant.setDataValue(key, enriched[key]);
  }
  res.json({ data: typeof result?.toJSON === 'function' ? result.toJSON() : result });
}

export async function createProduct(req, res) {
  const data = normalizePricing(req.validated);

  const result = await catalogMutation(req, req.validated, 201, async (transaction) => {
    const categoryIds = data.category_ids ?? [];
    const primaryCategoryId = data.primary_category_id ?? null;

    await validateCategories(categoryIds, transaction);
    await validateBrand(data.brand_id, transaction);

    const created = await Product.create(
      {
        ...Object.fromEntries(
          storedCatalogFields
            .filter((field) => Object.hasOwn(data, field))
            .map((field) => [field, data[field]]),
        ),
        product_name: data.product_name,
        slug: data.slug,
        brand_id: data.brand_id ?? null,
        short_description: data.short_description ?? null,
        description: data.description ?? null,
        product_status: data.product_status ?? 'draft',
      },
      { transaction },
    );

    if (env.CONFIGURATION_PRODUCTS_ENABLED) {
      await created.update(
        {
          is_configuration_group: data.product_type === 'variable',
          inventory_managed: data.product_type !== 'variable',
          attributes: data.attributes ?? {},
        },
        { transaction },
      );
      if (created.inventory_managed)
        await setConfigurationStock(
          req,
          created.product_id,
          data.stock_quantity ?? 0,
          transaction,
          true,
        );
    }
    if (categoryIds.length > 0) {
      await replaceProductCategories(
        created.product_id,
        categoryIds,
        primaryCategoryId,
        transaction,
      );
    }

    await publishProductCatalog(created.product_id, transaction);
    return created;
  });

  sendMutation(res, result);
}

export async function updateProduct(req, res) {
  const product = await sequelize.transaction(async (transaction) => {
    const existing = await findProduct(req.validatedParams.productId, transaction);
    if (env.CONFIGURATION_PRODUCTS_ENABLED) await auditContext(req, transaction);

    const data = normalizePricing(req.validated, existing.toJSON());
    if (
      env.CONFIGURATION_PRODUCTS_ENABLED &&
      data.product_type === 'variable' &&
      (await configurationLink({ productId: existing.product_id }, transaction))
    )
      throw new HttpError(
        409,
        'Edit configurations through their existing group; configurations cannot contain nested variants',
      );
    if (
      env.CONFIGURATION_PRODUCTS_ENABLED &&
      data.product_type === 'simple' &&
      existing.is_configuration_group
    ) {
      if (
        await models.productVariant.count({
          where: { product_id: existing.product_id },
          transaction,
        })
      )
        throw new HttpError(
          409,
          'Remove the existing variants before switching to simple',
        );
      await existing.update(
        { is_configuration_group: false, inventory_managed: true },
        { transaction },
      );
      await setConfigurationStock(
        req,
        existing.product_id,
        data.stock_quantity ?? 0,
        transaction,
        true,
      );
    }

    if (Object.hasOwn(data, 'brand_id')) await validateBrand(data.brand_id, transaction);

    const fields = [
      ...storedCatalogFields,
      'product_name',
      'slug',
      'brand_id',
      'short_description',
      'description',
      'product_status',
    ];

    for (const field of fields) {
      if (Object.hasOwn(data, field)) {
        existing[field] = data[field];
      }
    }

    if (
      env.CONFIGURATION_PRODUCTS_ENABLED &&
      existing.inventory_managed &&
      Object.hasOwn(data, 'stock_quantity')
    )
      await setConfigurationStock(
        req,
        existing.product_id,
        data.stock_quantity,
        transaction,
      );
    if (env.CONFIGURATION_PRODUCTS_ENABLED && data.attributes !== undefined)
      existing.attributes = data.attributes;
    await existing.save({ transaction });

    if (data.category_ids !== undefined) {
      await replaceProductCategories(
        existing.product_id,
        data.category_ids,
        data.primary_category_id ?? null,
        transaction,
      );
    } else if (data.primary_category_id !== undefined) {
      const primaryId = data.primary_category_id;

      if (primaryId !== null) {
        const association = await ProductCategory.findOne({
          where: {
            product_id: existing.product_id,
            category_id: primaryId,
          },
          transaction,
        });

        if (!association) {
          throw new HttpError(
            400,
            'The primary category must already be assigned to this product',
          );
        }
      }

      await ProductCategory.update(
        { is_primary: false },
        {
          where: { product_id: existing.product_id },
          transaction,
        },
      );

      if (primaryId !== null) {
        await ProductCategory.update(
          { is_primary: true },
          {
            where: {
              product_id: existing.product_id,
              category_id: primaryId,
            },
            transaction,
          },
        );
      }
    }

    const link = await configurationLink({ productId: existing.product_id }, transaction);
    if (link) {
      const fields = [
        'sku',
        'barcode',
        'regular_price',
        'sale_price',
        'offer_percent',
        'attributes',
        'stock_quantity',
      ];
      const variant = await models.productVariant.findByPk(link.variant_id, {
        transaction,
      });
      const patch = Object.fromEntries(
        fields.filter((f) => Object.hasOwn(data, f)).map((f) => [f, data[f]]),
      );
      if (Object.hasOwn(data, 'product_status'))
        patch.is_active = data.product_status === 'active';
      if (patch.attributes) {
        const duplicate = await models.productVariant.findOne({
          where: {
            product_id: link.group_product_id,
            attributes: { [Op.eq]: patch.attributes },
            id: { [Op.ne]: variant.id },
          },
          transaction,
        });
        if (duplicate)
          throw new HttpError(409, 'This variant attribute combination already exists');
      }
      await variant.update(patch, { transaction });
      const group = await Product.findByPk(link.group_product_id, { transaction });
      await refreshGroupConfigurations(req, group, transaction);
      await publishProductCatalog(link.group_product_id, transaction);
    } else await refreshGroupConfigurations(req, existing, transaction);
    await publishProductCatalog(existing.product_id, transaction);
    return existing;
  });

  res.json({
    data:
      env.CONFIGURATION_PRODUCTS_ENABLED && product.inventory_managed
        ? {
            ...product.toJSON(),
            stock_quantity: await configurationStock(product.product_id),
          }
        : product,
  });
}

export async function deleteProduct(req, res) {
  await sequelize.transaction(async (transaction) => {
    const product = await findProduct(req.validatedParams.productId, transaction);
    if (env.CONFIGURATION_PRODUCTS_ENABLED) await auditContext(req, transaction);
    const link = await configurationLink({ productId: product.product_id }, transaction);
    await archiveConfigurations(
      req,
      link?.group_product_id ?? product.product_id,
      transaction,
      link?.variant_id,
    );
    if (link)
      await models.productVariant.update(
        { is_active: false, deleted_at: new Date() },
        { where: { id: link.variant_id }, transaction },
      );
    await deactivateProductCatalog(product.product_id, transaction);
    await product.update({ product_status: 'archived' }, { transaction });
    await models.productVariant.update(
      { is_active: false, deleted_at: new Date() },
      { where: { product_id: product.product_id }, transaction },
    );
    await product.destroy({ transaction });
  });
  res.status(204).end();
}

// ======================================================
// UPLOAD PRODUCT IMAGES
// ======================================================

async function requireConfigurationGalleryWrite(req) {
  const link = await configurationLink({ productId: req.validatedParams.productId });
  if (link)
    throw new HttpError(
      409,
      `Use the existing gallery route /api/admin/products/${link.group_product_id}/variants/${link.variant_id}/images to edit this configuration's images`,
    );
}
export async function uploadImagesProduct(req, res, next) {
  await requireConfigurationGalleryWrite(req);
  productImageUpload(req, res, async (error) => {
    if (error) return next(new HttpError(400, error.message));
    try {
      const files = req.files ?? [];
      const payload = files.map((file) => ({
        type: file.mimetype,
        hash: fingerprint(file.buffer.toString('base64')),
      }));
      // Reserve journals before acquiring a transaction connection (avoids pool starvation).
      const reserved = [];
      for (const file of files)
        reserved.push(
          await reserveImage('products', req.validatedParams.productId, file),
        );
      const result = await catalogMutation(req, payload, 201, async (transaction) => {
        const product = await findProduct(req.validatedParams.productId, transaction);
        const existingImages = await models.productImage.findAll({
          where: { product_id: product.product_id },
          transaction,
        });
        if (existingImages.length + files.length > MAX_PRODUCT_IMAGES)
          throw new HttpError(
            400,
            `A product can have a maximum of ${MAX_PRODUCT_IMAGES} images`,
          );
        const saved = [];
        let hasPrimary = existingImages.some((image) => image.is_primary);
        for (const [index, file] of files.entries()) {
          const { key, journal } = await stageImage(reserved[index], file, transaction);
          saved.push(
            await models.productImage.create(
              {
                product_id: product.product_id,
                image_url: imageUrl(key),
                s3_key: key,
                sort_order:
                  Math.max(-1, ...existingImages.map((image) => image.sort_order)) +
                  index +
                  1,
                is_primary: !hasPrimary,
              },
              { transaction },
            ),
          );
          await journal.destroy({ transaction });
          hasPrimary = true;
        }
        await publishProductCatalog(product.product_id, transaction);
        return saved;
      });
      sendMutation(res, result);
    } catch (uploadError) {
      next(uploadError);
    }
  });
}

// ======================================================
// LIST PRODUCT IMAGES
// ======================================================

export async function listProductImages(req, res) {
  await findProduct(req.validatedParams.productId);
  const gallery = await galleryForConfigurationProduct(req.validatedParams.productId);
  if (gallery) return res.json({ data: gallery.effective_images });
  const product = await findProduct(req.validatedParams.productId);

  const images = await models.productImage.findAll({
    where: { product_id: product.product_id },
    order: [
      ['is_primary', 'DESC'],
      ['sort_order', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  res.json({ data: images });
}

// ======================================================
// SET PRIMARY PRODUCT IMAGE
// ======================================================

export async function setPrimaryProductImage(req, res) {
  await requireConfigurationGalleryWrite(req);
  const { productId, imageId } = req.validatedParams;
  const image = await sequelize.transaction(async (transaction) => {
    await findProduct(productId, transaction);
    const selected = await models.productImage.findOne({
      where: { id: imageId, product_id: productId },
      transaction,
    });
    if (!selected) throw new HttpError(404, 'Product image not found');
    await models.productImage.update(
      { is_primary: false },
      { where: { product_id: productId }, transaction },
    );
    const updated = await selected.update({ is_primary: true }, { transaction });
    await publishProductCatalog(productId, transaction);
    return updated;
  });
  res.json({ data: image });
}

// ======================================================
// REPLACE AN EXISTING PRODUCT IMAGE
// ======================================================

export async function replaceProductImage(req, res, next) {
  await requireConfigurationGalleryWrite(req);
  productImageUpload(req, res, async (error) => {
    if (error) return next(new HttpError(400, error.message));
    let removedKey;
    try {
      const { productId, imageId } = req.validatedParams;
      const files = req.files ?? [];
      if (files.length !== 1)
        throw new HttpError(400, 'Upload exactly one image using uploadimage');
      const file = files[0];
      const reserved = await reserveImage('products', productId, file);
      const updated = await sequelize.transaction(async (transaction) => {
        await findProduct(productId, transaction);
        const image = await models.productImage.findOne({
          where: { id: imageId, product_id: productId },
          transaction,
        });
        if (!image) throw new HttpError(404, 'Product image not found');
        const { key, journal } = await stageImage(reserved, file, transaction);
        removedKey = image.s3_key;
        await queueImageCleanup(removedKey, transaction);
        await image.update({ s3_key: key, image_url: imageUrl(key) }, { transaction });
        await journal.destroy({ transaction });
        await publishProductCatalog(productId, transaction);
        return image;
      });
      await finishImageCleanup([removedKey]);
      res.json({ data: updated });
    } catch (replaceError) {
      next(replaceError);
    }
  });
}

// ======================================================
// DELETE A PRODUCT IMAGE
// ======================================================

export async function deleteProductImage(req, res) {
  await requireConfigurationGalleryWrite(req);
  const { productId, imageId } = req.validatedParams;
  let removedKey;
  await sequelize.transaction(async (transaction) => {
    await findProduct(productId, transaction);
    const image = await models.productImage.findOne({
      where: { id: imageId, product_id: productId },
      transaction,
    });
    if (!image) throw new HttpError(404, 'Product image not found');
    // Commit cleanup intent with the DB deletion; storage failures cannot break live references.
    removedKey = image.s3_key;
    await queueImageCleanup(removedKey, transaction);
    await image.destroy({ transaction });
    if (image.is_primary) {
      const nextImage = await models.productImage.findOne({
        where: { product_id: productId },
        order: [
          ['sort_order', 'ASC'],
          ['id', 'ASC'],
        ],
        transaction,
      });
      if (nextImage) await nextImage.update({ is_primary: true }, { transaction });
    }
    await publishProductCatalog(productId, transaction);
  });
  await finishImageCleanup([removedKey]);
  res.status(204).end();
}
