# Customer OTP API

For the centralized route registry, auth defaults and new-module examples, see [ADDING-API.md](ADDING-API.md).

The customer app now uses `/api/app` OTP routes; older password-based app authentication documentation in README is superseded by this document. Admin authentication is unchanged.

## Local setup

Configure PostgreSQL through `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` in `.env`, set `OTP_MODE=development`, and run `npm run db:migrate` followed by `npm run dev`. The idempotent customer DDL is `sql/001-customers.sql`. It creates customers, verified identities, OTP challenges, login logs, customer addresses and family members. This migration does not create admin tables.

Development OTPs are random six-digit codes returned as `devCode` and displayed by the app. They are not sent by SMS/email. Requests expire after five minutes, allow five failed attempts and have a 30-second resend cooldown. Development delivery is disabled in production; a delivery provider must be integrated before release.

## Code organization

- `src/models/customer.model.js`: Sequelize models mapped to the existing customer tables; paranoid models handle soft deletion.
- `src/app/auth/`: OTP route definitions, payload schemas and authentication business logic.
- `src/app/customers/`: customer routes, profile/address/member schemas and controllers; account response and ownership logic live in customer.controller.js.
- `src/shared/customer-session.js`: common authentication middleware, session issuance, token hashing and cookie handling, also used by cart/product routes.
- `src/shared/customer-otp.js`: OTP hashing, constants and the PostgreSQL contact lock.
- `src/shared/validation.js`: common body/parameter validation middleware. Controllers receive validated payloads.

Customer reads/writes use Sequelize model methods and managed transactions. The sole raw runtime query is the PostgreSQL advisory lock used to serialize requests for a contact that may not have a database row yet. No schema migration or app payload changes are needed for this refactor.

## Endpoint reference

Public master APIs (no login required):

- `GET /api/app/faqs`: active questions/answers in display order.
- `GET /api/app/states`: state/UT UUIDs and names.
- `GET /api/app/states/:stateId/cities`: cities belonging to the selected state.

All return `{ data: [...] }`. The app uses these APIs for FAQs and address dropdowns, with loading/error/retry states. Address payloads continue storing the selected names.

`npm run db:migrate` also applies `sql/002-masters.sql` and seeds the existing app data: 36 states/UTs, 4,198 cities and 7 FAQs. Seed snapshots and location attribution/license are in `seed/`. Reruns insert missing records without replacing existing IDs or editing FAQ answers. Standalone reseeding after migration: `node scripts/seed-masters.js`.

All paths below are relative to `/api/app`. JSON requests are required.

| Method | Path | Payload / result |
| --- | --- | --- |
| POST | /auth/otp/request | `{method:"phone" or "email",contact:"..."}`; challengeId, devCode |
| POST | /auth/otp/verify | `{challengeId,code,deviceInfo?:{platform,osVersion,model}}`; account |
| GET | /auth/me | Current account |
| POST | /auth/logout | Revoke current session, expire cookie |
| POST | /auth/logout-all | Revoke all customer sessions |
| PUT | /customers/me/profile | `{firstName,lastName,phone,email,dateOfBirth:"YYYY-MM-DD",gender,address}` |
| GET, POST | /customers/me/addresses | List / add address |
| PUT, DELETE | /customers/me/addresses/:id | Update / soft-delete owned address |
| GET, POST | /customers/me/family-members | List / add member |
| PUT, DELETE | /customers/me/family-members/:id | Update / soft-delete owned member |
| DELETE | /customers/me | Soft-delete account and revoke sessions |

Address fields: `line1`, `line2`, `landmark`, `state`, `city`, `postalCode`. Member fields: `name`, `relationship` (Self, Mother, Father, Spouse, Grandparent, Other), optional `phone` (ten digits), required `dateOfBirth` (YYYY-MM-DD; valid non-future date, age 0?120 years) and `gender` (Female, Male, Other, Prefer not to say). Run `npm run db:migrate` to apply `006-family-member-birthdate.sql` before starting the updated API. Customer, member and address IDs are UUIDs. Addresses belong to the logged-in customer independently of family members.

Account responses contain `user`, `identities`, `addresses`, `members`. `user.profileCompleted` controls onboarding versus Home. First profile completion atomically saves the profile, initial address and Self member. Repeating completion does not duplicate them. Secondary profile email/phone is contact information, not automatically a verified login identity. Use the original verified contact to return to that account; linking another login identity requires a separate verification flow.

Browsers use an HttpOnly cookie; native requests send `X-App-Client: native` and use the returned opaque token as `Authorization: Bearer ...`. Native tokens are persisted using Expo SecureStore. Only token hashes are stored in login logs, alongside login time, expiry, device data, IP/user agent and `deleted_at`. Customer server sessions have no time expiry; logout/revocation ends access. Browser cookies renew on use with a 400-day lifetime, subject to browser limits. Logout revokes server access immediately. Web mutation requests require an allowed Origin; configure `ALLOWED_ORIGINS` for your Expo web origin.

## App connection and checks

In `Mera Beta/.env`, set `EXPO_PUBLIC_CUSTOMER_API_URL` to the API origin, e.g. `http://192.168.1.10:3000` for a phone on the same Wi-Fi. Development native builds otherwise infer the Expo host; web defaults to localhost:3000. For mobile web, explicitly configure the computer LAN API URL and allow the corresponding web origin. Production requires an explicit HTTPS API URL. Restart Expo after changing environment variables. Existing custom native development builds must be rebuilt to include Expo SecureStore.

Run `node test/customer.integration.test.js` in API with the local database available. It uses isolated test identities and removes its records afterward. Run `npm run lint` in API and `npm run typecheck` in the app. Product/order persistence remains the existing app implementation; this change binds customer authentication, profile, family and addresses.

Family member create/update calculates `age` on the server from `dateOfBirth` and saves both. Responses include both fields; stored age represents age at the last save.
