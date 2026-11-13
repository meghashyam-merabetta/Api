import { MAX_PRODUCT_IMAGES } from '../src/shared/product-images.js';
// Read-only catalogue checks, plus rollback-only availability/price checks.
import assert from 'node:assert/strict';
import {
  productCatalog,
  sellableProduct,
  categoryIcon,
  productImageUrl,
} from '../src/app/products/catalog.js';
import { listProducts, getProduct } from '../src/app/products/products.controller.js';
import { sequelize } from '../src/config/database.js';
import { QueryTypes } from 'sequelize';
try {
  const catalog = await productCatalog();
  assert.ok(catalog.products.length, 'No active products to verify');
  assert.equal(new Set(catalog.products.map((p) => p.id)).size, catalog.products.length);
  for (const p of catalog.products) {
    assert.ok(p.mrp >= p.price && p.price > 0);
    assert.ok(catalog.categories.some((c) => c.id === p.categoryId));
    assert.ok(p.images.length <= MAX_PRODUCT_IMAGES);
    const images = await sequelize.query(
      'SELECT image_url FROM product_images WHERE product_id=:id ORDER BY is_primary DESC,sort_order,id',
      { replacements: { id: p.productId }, type: QueryTypes.SELECT },
    );
    assert.deepEqual(
      p.images,
      [
        ...new Set(
          images
            .map((i) => i.image_url)
            .filter(Boolean)
            .map(productImageUrl),
        ),
      ].slice(0, MAX_PRODUCT_IMAGES),
    );
  }
  const p = catalog.products.find((p) => p.available);
  assert.ok(p);
  let detail;
  await getProduct(
    { validatedParams: { id: p.id } },
    {
      json: (body) => {
        detail = body.data;
      },
    },
  );
  assert.equal(detail.price, p.price);
  await listProducts(
    { validatedQuery: { limit: 1, offset: 0, brand: p.brandId, q: p.name } },
    {
      json: (body) => {
        assert.equal(body.data.length, 1);
        assert.ok(body.total >= 1);
      },
    },
  );
  assert.equal((await sellableProduct(p.id, 1)).id, p.id);
  await assert.rejects(sellableProduct(p.id, p.stock + 1));
  await assert.rejects(sellableProduct('demo-product', 1));
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query("UPDATE products SET product_status='inactive' WHERE id=:id", {
      replacements: { id: p.productId },
      transaction,
    });
    await assert.rejects(sellableProduct(p.id, 1, transaction));
    await sequelize.query("UPDATE products SET product_status='active' WHERE id=:id", {
      replacements: { id: p.productId },
      transaction,
    });
    await sequelize.query('UPDATE vendor_products SET selling_price=1 WHERE id=:id', {
      replacements: { id: p.id.slice(5) },
      transaction,
    });
    assert.equal((await sellableProduct(p.id, 1, transaction)).price, 1);
  } finally {
    await transaction.rollback();
  }
  assert.equal(categoryIcon('Mobility Aids'), 'accessibility-outline');
  assert.equal(categoryIcon('Baby Diaper'), 'water-outline');
  console.log(
    JSON.stringify({
      passed: true,
      products: catalog.products.length,
      categories: catalog.categories.length,
      brands: catalog.brands.length,
      productsWithoutImages: catalog.products.filter((p) => !p.images.length).length,
    }),
  );
} finally {
  await sequelize.close();
}
