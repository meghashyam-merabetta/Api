# Lab booking and LocationIQ address flow

Run `npm run db:migrate`. Migration `008-location-address.sql` adds house/building fields and LocationIQ JSON to saved addresses. Existing addresses remain valid. Area seeding is no longer needed for bookings.

Set `LOCATIONIQ_API_KEY` in `API/.env` and restart the API. The server-side token needs autocomplete, reverse geocoding and static maps access; do not put it in an Expo public variable. See [autocomplete](https://docs.locationiq.com/docs/autocomplete), [reverse geocoding](https://docs.locationiq.com/docs/reverse-geocoding) and [static maps](https://docs.locationiq.com/docs/static-maps-api-reference).

Address fields include houseNumber, buildingName, landmark, line1/line2, city/state/postalCode, and location (provider, placeId, displayName, latitude, longitude, original provider address). Users can fill missing city/state/PIN while the original provider response remains intact. New onboarding asks only for personal details; addresses are added later in Family & Addresses or checkout.

Lab checkout: tests → family member → address and date/time → review → booking success. Geographic serviceability selection has been removed.

Authenticated endpoints:
- GET /api/app/locations/search?q=Baner: India-only LocationIQ suggestions.
- GET /api/app/locations/reverse?lat=18.56&lon=73.78: full provider address and exact selected pin.
- GET /api/app/locations/map?lat=18.56&lon=73.78&zoom=16: 600×400 map data URI, supporting app pin adjustment and zoom.
- GET /api/app/lab-slots: today plus six days in Asia/Kolkata; 7–9 AM, 9–11 AM, 11 AM–1 PM and 2–4 PM. Passed start times are unavailable.
- POST /api/app/lab-bookings: requestKey, memberId, structured address, notes, collectionDate (YYYY-MM-DD), slotId (07-09, 09-11, 11-13, 14-16), items [{id,quantity}].
- GET /api/app/lab-bookings: only the signed-in customer's bookings.

The server revalidates member ownership, birthdate/gender, lab availability, address, seven-day date range and unexpired slot. Prices and snapshots come from API/seed/lab-offerings.json and tests.json, never client totals. Retry the same requestKey to retrieve the same booking, even if its slot has since passed. Payment remains pending; no payment messages are sent. Slots are fixed windows without provider capacity integration.

Labs must remain active with home collection enabled. The legacy lab-areas endpoint is retained but unused by the app.

Run `node scripts/check-lab-bookings.js` and `node scripts/check-address-flow.js` against a migrated local DB for persistence, ownership, no-address onboarding, location fields, scheduling and retries. They create temporary records and remove only those records afterward. `node --test scripts/collection-slots.test.js` tests date/time boundaries.

Products use an app-only dummy gateway with success/failure/cancel controls, no external payment provider and no real charge. Product orders remain in the existing device storage. Labs persist through the API and reload after login. Completing either flow clears only purchased quantities in its own cart section.

The mobile browser smoke test is `Mera Beta/scripts/checkout-flow-smoke.cjs`. Build `dist-checkout` with EXPO_PUBLIC_CUSTOMER_API_URL=http://127.0.0.1:4175 and EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:4175/catalog first. Provider/API responses are mocked; this test does not verify a live LocationIQ token.
