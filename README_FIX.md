# Delta Kebab backend integration fix (local JSON)

This is your original backend with corrections; existing branch, product, customization, and order JSON files remain intact.

## Changes
- Fix duplicate HTTP request listeners between Express and Socket.IO (ERR_HTTP_HEADERS_SENT).
- Preserve Express JSON request parsing for login and customer orders.
- Expand default CORS origins for local customer and management websites.
- Guard Express error middleware against sending headers twice.
- Seed a local-only super-admin account with a known demo password.

## Run (Windows / VS Code)
1. Back up your old backend folder and **especially its data folder**. If you already have real orders, copy your old data/*.json into this updated project's data/ before starting; this ZIP contains the original uploaded data snapshot, not your newer live data.
2. Copy .env.example to .env if needed. Keep your existing JWT_SECRET if you already have one.
3. npm install
4. npm run seed (updates demo users only; doesn't reset orders or products)
5. npm run dev
6. Open http://localhost:5000/health and http://localhost:5000/api/v1/restaurants
7. Serve DeltaKebab_Admin_Connected_Fixed.html with VS Code Live Server (port 5500) or any static server.

Demo admin: admin@deltakebab.demo
Demo password: DeltaKebabDemo2026!
These credentials are for local testing only. **Never expose this seeded demo admin publicly.**

Customer integration: Your existing customer V4 can continue using http://localhost:5000/api/v1/restaurants, /api/v1/restaurants/:id/products, and POST /api/v1/orders. Products and order totals are validated against branch-specific JSON data. The management HTML reads the same server's orders and menus. Browser login must be authenticated against the backend; HTML cannot bypass that.

New orders emit Socket.IO `order:new` only when actually created. Loading/syncing historical orders must not play an alert.
