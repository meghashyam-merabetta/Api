import test from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../src/config/database.js';
import { productCatalog } from '../src/app/products/catalog.js';

test('phone catalog caps galleries at six without mutating stored images', async () => {
  const originalQuery = sequelize.query;
  const images = Array.from({ length: 12 }, (_, index) => ({
    url: `https://example.com/image-${index}.png`,
  }));
  sequelize.query = async (sql) => {
    if (sql.includes('FROM categories'))
      return [{ id: '1', name: 'Care', parentId: null }];
    if (sql.includes('FROM brands')) return [];
    return [
      {
        id: '7',
        product_name: 'Product',
        category_id: '1',
        subcategory_id: null,
        selling_price: '10.00',
        mrp: '20.00',
        available_stock: 3,
        image_urls: images.map((image) => image.url),
      },
    ];
  };
  try {
    const result = await productCatalog();
    assert.equal(result.products[0].images.length, 6);
    assert.deepEqual(
      result.products[0].images,
      images.slice(0, 6).map((image) => image.url),
    );
    assert.equal(result.products[0].image, images[0].url);
  } finally {
    sequelize.query = originalQuery;
  }
});
