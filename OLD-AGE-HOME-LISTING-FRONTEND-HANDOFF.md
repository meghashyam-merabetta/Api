# Public Old Age Home Listing API — Frontend Handoff

The backend now exposes customer-safe old-age-home listings using the same public list/detail conventions as `/api/app/products`. No customer or admin login is required. Only enrollments whose client and admin records are both `ACTIVE` and whose admin record is not soft-deleted can be returned.

## Endpoints

### List and filter homes

`GET /api/app/old-age-homes`

Optional query parameters:

- `limit`: integer `1..500`, default `100`
- `offset`: nonnegative integer, default `0`
- `q`: searches home name, address, city, and state
- `city`: case-insensitive exact city filter
- `state`: case-insensitive exact state filter
- `service`: one of `assistedLiving`, `independentLiving`, `dementiaCare`, `palliativeCare`, `homeHospital`, `dayCareServices`, `meals`, `recreationalActivities`, or `other`

Response:

```json
{
  "data": [
    {
      "id": "2e5ff950-94fd-4755-abde-8712be467e19",
      "name": "Shantiban Old Age Home",
      "subtitle": "Pune, Maharashtra",
      "homeName": "Shantiban Old Age Home",
      "yearEstablished": 2011,
      "organizationType": "Private",
      "address": "Wakad",
      "city": "Pune",
      "state": "Maharashtra",
      "pinCode": "411057",
      "website": null,
      "totalCapacity": 40,
      "currentResidents": 13,
      "availableCapacity": 27,
      "medicalFacilities": {},
      "servicesOffered": { "assistedLiving": true },
      "facilityPricing": { "assistedLiving": { "from": 15000, "to": 20000 } },
      "image": "https://.../front.jpg",
      "images": ["https://.../front.jpg"],
      "video": null
    }
  ],
  "total": 1
}
```

Use `data` for the current page and `total` to calculate pagination. Preserve `id` as a string.

### Get one home

`GET /api/app/old-age-homes/:id`

The response is `{ "data": { ...same home shape... } }`. The ID must be the UUID returned by the list. An inactive, deleted, or unknown home returns `404`.

### Load the complete catalog

`GET /api/app/old-age-homes/catalog`

Response: `{ "data": { "oldAgeHomes": [ ... ] } }`. This mirrors the app product catalog loading pattern and is suitable when the web app wants to load all active homes once and filter client-side.

## Recommended integration

```ts
type OldAgeHome = {
  id: string;
  name: string;
  subtitle: string;
  homeName: string;
  city: string;
  state: string;
  image: string | null;
  images: string[];
  video: string | null;
  totalCapacity: number;
  currentResidents: number;
  availableCapacity: number;
  medicalFacilities: Record<string, boolean | string>;
  servicesOffered: Record<string, boolean | string>;
  facilityPricing: Record<string, { from: number; to: number }>;
};

const response = await fetch(
  `${API_BASE}/api/app/old-age-homes?limit=24&offset=0&city=${encodeURIComponent(city)}`
);
if (!response.ok) throw new Error(`Old age homes failed: ${response.status}`);
const result: { data: OldAgeHome[]; total: number } = await response.json();
```

Render a normal empty state when `data` is empty. Treat `image`, `video`, and `website` as nullable. `images`, `medicalFacilities`, `servicesOffered`, and `facilityPricing` are always returned as safe arrays/objects, even when database values are null.

The public API intentionally excludes contact-person details, owner details, phone/email, registration documents, certificates, bank information, signatures, approval metadata, and deleted/inactive records.
