import test from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../src/config/database.js';
import { productCatalog } from '../src/app/products/catalog.js';

test('customer catalog returns ten ordered images rather than truncating at six', async () => {
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
        product_id: '7',
        name: 'Product',
        variant_id: '8',
        offer_id: '9',
        selling_price: '10.00',
        mrp: '20.00',
        stock: 3,
        categories: [{ id: '1', name: 'Care' }],
        images,
      },
    ];
  };
  try {
    const result = await productCatalog();
    assert.equal(result.products[0].images.length, 10);
    assert.deepEqual(
      result.products[0].images,
      images.slice(0, 10).map((image) => image.url),
    );
    assert.equal(result.products[0].image, images[0].url);
  } finally {
    sequelize.query = originalQuery;
  }
});
