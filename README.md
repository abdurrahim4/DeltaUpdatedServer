# Delta Kebab — Multi-branch local JSON backend

**Node.js 20+ / Express / Socket.IO. No MongoDB required.** A local development backend, not production-ready storage.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env: strong JWT_SECRET, DEMO_SEED_PASSWORD, CORS_ORIGINS
npm run seed
npm run dev
npm test
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

Sample logins after `npm run seed`: `owner@deltakebab.demo`, `kowale@deltakebab.demo`, `gdansk@deltakebab.demo`, `pruszcz@deltakebab.demo`. All use your private `DEMO_SEED_PASSWORD`. Never use demo accounts publicly.

## API

Base URL: `http://localhost:5000/api/v1`. Responses use `{data: ...}` or `{error: ...}`. List endpoints also return `pagination`.

Public: `GET /restaurants`, `/restaurants/:id`, `/restaurants/:id/products`, `/restaurants/:id/products/:productId`, `/restaurants/:id/categories`, `/restaurants/:id/customizations`.

Auth: `POST /auth/login` with `{"email":"kowale@deltakebab.demo","password":"<your seed password>"}`. Use returned JWT in `Authorization: Bearer <token>`.

Customer: `POST /orders` with:

```json
{"branchId":"kowale","customer":{"name":"Test Customer","phone":"123456789","address":"Demo street"},"paymentMethod":"cash_on_delivery","idempotencyKey":"checkout-test-0001","items":[{"productId":"kowale-p1","quantity":1,"selections":{"size":["standard"],"meat":["chicken"],"sauce":["garlic"]}}]}
```

Guest checkout returns order ID, but `GET /orders/:id` currently requires branch employee authentication. Guest order tracking needs a separate secret tracking token in a later iteration.

Management (Bearer token required):

- `GET /management/branches/:branchId/orders?status=new`
- `PATCH /management/branches/:branchId/orders/:orderId/status` with `{ "status":"preparing" }` (or `delivering`, `delivered`, `cancelled` with `reason`)
- `GET /management/branches/:branchId/products`
- `POST /management/branches/:branchId/products` (manager/owner)
- `PATCH /management/branches/:branchId/products/:productId`
- `DELETE /management/branches/:branchId/products/:productId` (archive)
- `POST /management/branches/:branchId/products/:productId/restore`
- `PATCH /management/branches/:branchId/products/:productId/availability`
- `POST /management/branches/:branchId/products/:productId/duplicate`
- `POST /management/branches/:branchId/products/:productId/copy` with `{ "targetBranchId":"gdansk" }` (must own both)
- `PATCH /management/branches/:branchId/bulk/products`
- `GET/PATCH /management/branches/:branchId/settings`
- `GET /management/branches/:branchId/categories` and `/customizations`

**Socket.IO**: connect with `auth:{token:jwt}`. Receive `order:new` and `order:updated` for authorized branch rooms only. Every event has a unique `eventId`. On reconnection, call `orders:sync` with `{branchId}` and callback, and reconcile orders **without playing a sound**. Play sound only on genuinely unseen `order:new` event IDs, never for initial loads or sync. Browser autoplay/background limits still apply.

## Data and storage

`data/` contains 10 branches, 70 branch products, 5 categories, 4 customization groups, orders and inventory. All prices in PLN. Product price and customizations are recalculated on the server and snapshotted into orders. JSON mutations are serialized **per collection in a single Node.js process** and persisted using temporary-file + atomic rename. This is not a transactional database, is not safe for multiple server processes, and is not suitable for high concurrency.

## Future MongoDB migration

Swap `src/repositories/jsonStore.js` for a MongoDB implementation while preserving service contracts. Suggested indexes: `branches(id)` unique, `products(branchId,id)` unique, `products(branchId,categoryId,available,archived)`, `orders(branchId,createdAt)`, `orders(branchId,status,createdAt)`, `orders(branchId,idempotencyKey)` partial unique, `users(email)` unique. Always scope management queries and writes by authorized branch IDs. Use durable event delivery for production, and implement transactional idempotency.

## Current limitations

This is a runnable **development baseline**, not a finished large-scale platform. Product image uploads, editable customization/category CRUD, inventory deductions, customer tracking tokens, refresh tokens, audit logs, distributed rate limiting, and production load testing are not yet implemented. Do not expose this JSON server to the public internet.
