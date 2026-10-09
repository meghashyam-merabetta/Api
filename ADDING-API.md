# Adding an API module

All application and admin modules are registered in **src/routes/index.js**.
Authentication defaults to **true**; only routes explicitly declaring **auth: false** are public.
Infrastructure health probes are public and defined in app.js.

Create a module folder with controller, routes and schema files (subfolders are also fine; adjust imports).

## 1. Define the payload

```js
// src/app/feedback/feedback.schema.js
import { z } from 'zod';

export const createFeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  message: z.string().trim().min(1).max(1000),
}).strict();
```

## 2. Write the controller

After adding a Feedback Sequelize model, its SQL migration, and a feedback entry in the models object in src/models/index.js:

```js
// src/app/feedback/feedback.controller.js
import { models } from '../../models/index.js';

export async function createFeedback(req, res) {
  const feedback = await models.feedback.create({
    ...req.validated,
    customerId: req.credential.id,
  });
  res.status(201).json({ data: feedback });
}
```

## 3. Export route objects

```js
// src/app/feedback/feedback.routes.js
import * as controller from './feedback.controller.js';
import * as schema from './feedback.schema.js';

export const feedbackRoutes = [
  {
    method: 'post',
    path: '/',
    auth: true,
    schema: schema.createFeedbackSchema,
    handler: controller.createFeedback,
  },
];
```

## 4. Register once

Import feedbackRoutes in src/routes/index.js and add this to modules:

```js
{ path: '/app/feedback', realm: 'app', routes: feedbackRoutes }
```

The endpoint is now POST /api/app/feedback. Use realm: 'admin' for an admin module.
Do not create another Express Router or manually wire authentication in a module.

| Route property | Purpose |
| --- | --- |
| method / path | HTTP method (lowercase) and module-relative path |
| auth | Defaults to true; false explicitly makes the endpoint public |
| schema | Body schema; result in req.validated |
| params | URL params schema; result in req.validatedParams |
| query | Query schema; result in req.validatedQuery |
| middleware | Optional middleware such as rate limiting |
| handler | Controller function |

Protected controllers receive **req.credential**, a plain object with the logged-in Customer/User model's profile fields. Password hashes and session tokens are excluded. Access fields such as req.credential.id, firstName, phone, email (customer), or name, realm, active (admin). Session metadata remains in req.auth.sessionId and req.auth.realm. Public handlers must not assume credentials exist.

Customer sessions have no server-side expiry and remain valid until logout, logout-all, account deletion or explicit revocation. Existing expired/revoked sessions are not restored. Native tokens persist in SecureStore. Browser cookies have a rolling 400-day lifetime, subject to browser limits and user clearing cookies.

Admin JWTs, session expiry and cookies remain 24 hours; authenticated requests do not extend them. Customer tokens cannot authenticate admin routes.

Use req.credential.id for record ownership; never trust a customerId from the request body. Throw HttpError for expected failures; the common asyncHandler catches failures and forwards them to the error middleware. Controllers do not need duplicate try/catch blocks unless they can recover from an error. Use managed Sequelize transactions for multi-table changes.

Every module route explicitly includes auth: true or auth: false for readability, even though the safe default remains true. Keep business logic in controllers; customer account/ownership helpers also live in customer.controller.js, with no separate service file.
