# Product and Category CRUD compatibility fixes

This project maps Sequelize models to the existing PostgreSQL schema supplied for `brands`, `categories`, `products`, and `product_categories`.

- Product categories are read and written through `product_categories`; `products.category_id` is not assumed.
- Product and category create/update handlers use the supplied schema fields, including slugs and status fields.
- Product create/update category changes use Sequelize transactions.
- Category deletion checks `product_categories` and child categories before deletion.
- No migration, `sequelize.sync`, or schema-changing operation is run by startup.
- Catalog corrections, migration instructions, and new brand/variant contracts are documented in [ADMIN-CATALOG-API.md](ADMIN-CATALOG-API.md).

## Configure and run

1. Copy `.env.example` to `.env`.
2. Fill in the actual PostgreSQL connection values and generate two different random JWT secrets of at least 32 characters. Do not use the example placeholders.
3. Run `npm install`, `npm run check`, `npm test`, then `npm run dev`.

The test environment uses placeholder values only to allow tests that import the validated config to load. It does not supply working database credentials or prove live CRUD integration. Live product/category CRUD still needs testing against your database and authenticated admin account.
