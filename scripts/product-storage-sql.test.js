import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteProductStorageSql as rewrite } from '../src/shared/product-storage-sql.js';
test('rewrites legacy DML relations and leaves aliases/values intact', () => {
  assert.equal(
    rewrite('SELECT p.* FROM products p JOIN product_variants v ON v.product_id=p.id'),
    'SELECT p.* FROM product_records p JOIN product_variant_records v ON v.product_id=p.id',
  );
  assert.equal(
    rewrite('UPDATE public.products SET sku=:sku WHERE id=:id'),
    'UPDATE public.product_records SET sku=:sku WHERE id=:id',
  );
  assert.equal(
    rewrite('SELECT * FROM "public"."products" AS "Product"'),
    'SELECT * FROM "public"."product_records" AS "Product"',
  );
  assert.equal(
    rewrite("INSERT INTO products(name) VALUES('FROM products')"),
    "INSERT INTO product_records(name) VALUES('FROM products')",
  );
});
test('protects comments, dollar bodies, metadata names and quoted identifiers', () => {
  const source = `SELECT 'FROM products', 'customer''s JOIN products', "FROM products", $$UPDATE products SET sku='x'$$ FROM products -- FROM products\n/* FROM products /* JOIN products */ */ WHERE table_name='products'`;
  const expected = source.replace('$$ FROM products', () => '$$ FROM product_records');
  assert.equal(rewrite(source), expected);
});
test('locks rewrite to compatibility relations; schema/foreign keys stay physical', () => {
  assert.equal(
    rewrite('LOCK TABLE products,product_variants,inventory IN SHARE ROW EXCLUSIVE MODE'),
    'LOCK TABLE product_records,product_variant_records,inventory IN SHARE ROW EXCLUSIVE MODE',
  );
  const ddl =
    'ALTER TABLE products ADD COLUMN extra text; CREATE TABLE links(product_id bigint REFERENCES products(id)); TRUNCATE products CASCADE;';
  assert.equal(rewrite(ddl), ddl);
});

test('preserves escaped E-string content while rewriting the actual relation', () => {
  const sql = String.raw`SELECT E'customer\'s FROM products' FROM products`;
  assert.equal(
    rewrite(sql),
    String.raw`SELECT E'customer\'s FROM products' FROM product_records`,
  );
});
