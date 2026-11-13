# Admin labs frontend handoff

All routes are under `/api/admin/labs`, require existing admin authentication, and use JSON.
Responses use `{ data }`; lists also include `{ pagination: { total, limit, offset, hasMore } }`.

## Endpoints

- `GET /api/admin/labs`
- `GET /api/admin/labs/:labId`
- `POST /api/admin/labs`
- `PATCH /api/admin/labs/:labId`
- `DELETE /api/admin/labs/:labId`
- `GET /api/admin/labs/:labId/image`
- `POST` or `PUT /api/admin/labs/:labId/image`

List query parameters:

- `limit` (default `20`, maximum `100`) and `offset` (default `0`)
- `search` searches ID, name, and city
- `city`
- `active=true|false`
- `homeCollection=true|false`
- `sort_by=id|name|city|rating|createdAt|updatedAt`
- `sort_order=asc|desc`

## Create/edit form

Show only these business fields:

1. Lab ID — required on create, lowercase slug, disabled on edit
2. Name — required, maximum 200 characters
3. Description — required
4. Rating — required, 0 through 5, one decimal place
5. Lab logo — file picker
6. Primary color — required six-digit hex color
7. Background color — required six-digit hex color
8. City — required, maximum 100 characters
9. Home collection — required boolean
10. Active — required boolean

Do not show or submit `createdAt` or `updatedAt`. Do not submit `id` in PATCH bodies; the ID is
already in the URL and is immutable.

Create the lab row first with `image: "lab.png"`, then upload the selected logo. On edit, the logo
is optional and should upload only when the administrator selects a replacement.

Image upload contract:

```text
POST or PUT /api/admin/labs/:labId/image
Content-Type: multipart/form-data
field name: uploadimage
accepted: genuine JPEG, PNG, or WebP
maximum size: 5 MB
```

Use `FormData` and do not manually set the multipart `Content-Type`; the browser must add the
boundary. The response is `{ "data": { "id": "...", "image": "https://..." } }`. There is no
delete-image operation because every lab must have an image; replace it instead.

Create example:

```json
{
  "id": "redcliffe",
  "name": "Redcliffe Labs",
  "description": "Home sample collection and digital reports",
  "rating": 4.8,
  "image": "lab.png",
  "color": "#e26570",
  "bg": "#fff0f1",
  "active": true,
  "city": "Pune",
  "homeCollection": true
}
```

PATCH must contain only changed editable fields, for example:

```json
{
  "city": "Mumbai",
  "homeCollection": true,
  "active": true
}
```

The API returns `409` when an ID already exists. Deletion returns `409` for `redcliffe` and for any
lab referenced by packages, bookings, catalog sync, or service areas. In that case, offer
"Deactivate lab" by PATCHing `{ "active": false }` instead of repeatedly retrying deletion.

## Phone-app behavior that affects the admin UI

The phone app fetches `GET /api/app/labs/lablisting?limit=100` and consumes all ten business fields.
It uses `active` for visibility/availability, `city` for search, `homeCollection` for collection
messaging and booking eligibility, and the presentation fields for lab cards.

However, the current phone-app build deliberately allows selection and booking only when
`id === "redcliffe"`. It also displays the bundled Merabetta logo and overrides Redcliffe's name
and description. Creating another lab through admin will make it appear as unavailable but will not
make it bookable until the phone app and provider integration support that lab. Do not imply in the
CMS that creating a row alone activates a new booking provider.
