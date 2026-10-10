> Current customer app OTP setup and endpoints: [CUSTOMER-API.md](CUSTOMER-API.md). The app password-auth sections below describe the previous implementation.

# Node 24 + Express + PostgreSQL authentication API

Shared **User** and **Session** models for app and admin, with separate controllers, routes and validation schemas. Sequelize v6; Express v5; JavaScript ESM.

## Start locally

1. Install Node.js **24** (`nvm use 24` if available).
2. `npm ci`
3. Copy `.env.example` to `.env`.
4. Generate **two different** secrets with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"` and set the JWT secrets in `.env`.
5. Start PostgreSQL: `docker compose up -d db`, or configure an existing database using `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`.
6. `npm run db:migrate`
7. `npm run dev` (production: `npm start`).

PowerShell execution policy blocking npm? Use `npm.cmd` instead of `npm`.

## Structure

```text
src/
  models/           common User and Session models
  app/
    auth/           auth.controller.js, auth.routes.js, auth.schema.js
    products/       products.controller.js, products.routes.js, products.schema.js
    cart/           cart.controller.js, cart.routes.js, cart.schema.js
    routes/index.js mounts app modules
  admin/
    auth/           auth.controller.js, auth.routes.js, auth.schema.js
    products/       products.controller.js, products.routes.js, products.schema.js
    users/          users.controller.js, users.routes.js, users.schema.js
    routes/index.js mounts admin modules
  config/           validated environment, database, logger
  database/migrations/
  shared/           common auth, JWT/cookies, routing, security
  app.js            Express middleware and mounts
  server.js         startup and graceful shutdown
scripts/            migration, admin creation, syntax check
test/               authentication and optional PostgreSQL tests
```

Database tables: `users` and `sessions`, shared by both controllers. A server-assigned `realm` (`app` or `admin`) separates accounts and sessions. Email is unique per realm, so the same email may have separate app/admin accounts. Every auth query filters by realm; app registration cannot create an admin. Each module keeps its controller, routes and Zod schema together. Models remain common in `src/models/`.

Migration `002-shared-models` transfers existing app/admin rows to the shared tables transactionally, preserving IDs and sessions, then removes the old tables. Run `npm run db:migrate` before starting the updated API. Stop existing API instances during this schema transition. Migration `001-auth` remains unchanged for databases that already applied it.

## Authentication rules

| Realm | JWT | Cookie | Database session |
| --- | --- | --- | --- |
| app | No `exp` claim | 400 days, renewed on authenticated requests | No time expiry; revoked by logout/logout-all |
| admin | Exactly 24 hours from login | 24 hours, never extended by requests | Expires after 24 hours |

Browsers do not provide a truly never-expiring cookie. App login survives browser restarts while the cookie exists; clearing cookies, browser limits, or more than 400 days without use can require login again. A copied app JWT remains usable until its session is revoked, the account is disabled, or its signing secret is rotated.

Cookies are HttpOnly, host-only, scoped to `/api/app` or `/api/admin`, and Secure in production. JWT verification restricts algorithm, issuer and audience. Every protected request checks the database session and account status. Setting `active=false` disables access immediately. Tokens are not returned in JSON and Bearer authentication is not enabled.

## Endpoints

Dummy module APIs return `{ demo: true, data: [...] }` with static sample data, without database persistence or real cart/user lookup. Each accepts optional `?limit=1` (1–100, default 20).

| Method | Dummy endpoint | Auth |
| --- | --- | --- |
| GET | `/api/app/products` | false |
| GET | `/api/app/cart` | app |
| GET | `/api/admin/products` | admin |
| GET | `/api/admin/users` | admin |

| Method | Endpoint | Auth | JSON body |
| --- | --- | --- | --- |
| GET | `/api/app/public` | false | — |
| POST | `/api/app/auth/register` | false | `{ "name": "User", "email": "user@example.com", "password": "a-long-strong-password" }` |
| POST | `/api/app/auth/login` | false | `{ "email": "user@example.com", "password": "a-long-strong-password" }` |
| GET | `/api/app/auth/me` | true | — |
| POST | `/api/app/auth/logout` | true | `{}` |
| POST | `/api/app/auth/logout-all` | true | `{}` |
| POST | `/api/admin/auth/login` | false | `{ "email": "admin@example.com", "password": "a-long-strong-password" }` |
| GET | `/api/admin/auth/me` | true | — |
| POST | `/api/admin/auth/logout` | true | `{}` |
| POST | `/api/admin/auth/logout-all` | true | `{}` |
| GET | `/health/live` | false | — |
| GET | `/health/ready` | false | — |

Passwords require at least 12 characters and at most 72 UTF-8 bytes. Login/register return `{ user: { id, name, email } }`; logout returns 204. Errors use `{ error }` with validation details where applicable. Admin registration is intentionally available only through the provisioning script.

## Create an admin (PowerShell)

After running migrations:

```powershell
$env:ADMIN_NAME = 'Administrator'
$env:ADMIN_EMAIL = 'admin@example.com'
$credential = Get-Credential -UserName $env:ADMIN_EMAIL -Message 'Choose an admin password (12+ characters)'
$env:ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
npm.cmd run admin:create
Remove-Item Env:ADMIN_PASSWORD
```

## Set authentication per route

In the module's `*.routes.js` file, for example `src/app/products/products.routes.js` (paths are relative to the module mount):

```js
{ method: 'get', path: '/', auth: false, handler: productController.list },
{ method: 'post', path: '/', auth: true, schema: createProductSchema, handler: productController.create },
```

Omitting `auth` defaults to **true**. `auth: false` is public and skips token parsing; it does not populate `req.user`. Protected controllers receive `req.user` and `req.auth`; validated JSON is `req.validated`. App routes accept only app auth; admin routes accept only admin auth. Add resource ownership/role checks in business controllers as needed.

## Frontend / Postman

```js
await fetch('http://localhost:3000/api/app/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com', password: 'a-long-strong-password' }),
});
const response = await fetch('http://localhost:3000/api/app/auth/me', { credentials: 'include' });
```

Set `ALLOWED_ORIGINS` to exact frontend origins, without trailing slashes. Browsers supply `Origin` automatically. **Every write request**, including public login/register and logout, requires an allowed `Origin` and `Content-Type: application/json`; send `{}` for empty actions. In Postman/curl, add `Origin: http://localhost:5173` and enable/save cookies. This origin validation plus JSON-only writes prevents browser CSRF; public routes still enforce it. GET routes must not mutate business data.

For a genuinely cross-site frontend, production HTTPS and `COOKIE_SAME_SITE=none` are required; browser third-party cookie policies may still block it. Prefer a same-site deployment.

## Production deployment

- Set `NODE_ENV=production`, use HTTPS at your reverse proxy, and store secrets outside source control. Run `npm ci --omit=dev` or build the included Node 24 Docker image.
- Set `TRUST_PROXY_HOPS` only to match the actual trusted proxy topology; keep direct backend access blocked when trusting proxies.
- Use a managed PostgreSQL database with backups and a least-privilege runtime role. For TLS, set `DB_SSL=true`; optionally provide `DB_SSL_CA_FILE`. Certificate verification stays enabled.
- Run migrations once as a deployment step before starting replicas; the app never calls `sync({ alter: true })`. Do not run concurrent migration jobs. Database migrations use transactions.
- The included rate limits use process-local memory, suitable for one API instance. Before running multiple instances, configure a shared limiter store or equivalent gateway limits. Tune limits for expected traffic.
- The compose database credentials and exposed localhost port are for local development only.
- Schedule cleanup of expired `sessions` rows where `realm='admin'`. Retain app sessions until revoked to preserve the requested no-expiry behavior. Logout removes sessions immediately within the current realm.
- Monitor structured logs and health endpoints. Readiness checks database connectivity; migration execution is a separate required deployment step.
- The `sequelize` dependency overrides `uuid` to CommonJS-compatible `11.1.1` to address GHSA-w5hq-g745-h8pq. Tests cover Sequelize UUID defaults and transaction ID generation; revisit the override when upgrading Sequelize.

## Verification

Run `npm run lint` to check JavaScript with ESLint, or `npm run lint:fix` to apply automatic fixes. The Node.js ESM flat config lives in `eslint.config.js` and checks application code, tests, scripts and root JavaScript files. See the [ESLint configuration documentation](https://eslint.org/docs/latest/use/configure/configuration-files).

```sh
npm run check
npm test
```

HTTP tests use isolated in-memory model adapters with real middleware, password hashing and JWT verification. They do not substitute for testing PostgreSQL. To also run the real migration/constraint/cascade test, set `TEST_DATABASE_URL` to an **empty disposable PostgreSQL database**, then run `npm test`; the test refuses existing tables and removes the tables it creates. Without that variable, this test is reported as skipped.

References: [Express production security](https://expressjs.com/en/advanced/best-practice-security.html), [Sequelize transactions](https://sequelize.org/docs/v6/other-topics/transactions/), [jsonwebtoken options](https://github.com/auth0/node-jsonwebtoken).
