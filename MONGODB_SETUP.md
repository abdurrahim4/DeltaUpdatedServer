# Delta Kebab MongoDB setup

This upgrade retains your existing Express endpoints and stores the existing eight logical collections in MongoDB (`dk_collections`). It does not require changes to the admin panel if it already uses the same backend API.

## Setup on Windows

1. **Reset your MongoDB Atlas database-user password**: the original URI was shared in chat. Use the new password only in your private `.env`. In Atlas Network Access, allow your own current IP address (do not open access to everyone for production).
2. In the backend folder run `npm install` (this installs the `mongodb` driver and updates package-lock.json).
3. Edit `.env` (not `.env.example`):
   - `STORAGE_DRIVER=mongodb`
   - `MONGODB_URI=mongodb+srv://...` (the **new** private connection string)
   - `MONGODB_DB_NAME=deltakebab`
   - Keep your existing `JWT_SECRET` (32+ characters), `CORS_ORIGINS` and `PORT`.
   - If the new password contains reserved URI characters such as `@`, `#`, `?`, `/`, encode it for a URI.
4. Run `npm run db:init`. You should see `MongoDB connection successful; collections initialized.`
5. **Back up `data/`**, stop other backend processes and any writers, then import the existing JSON data. In Windows Command Prompt:
   `set CONFIRM_IMPORT=YES`
   `npm run db:migrate`
   In PowerShell:
   `$env:CONFIRM_IMPORT="YES"`
   `npm run db:migrate`
   Import refuses to overwrite existing nonempty/modified collections. If import fails partway, do not rerun blindly; inspect the imported data first.
6. Run `npm run dev` and visit `http://localhost:5000/health`. Expect `{"status":"ok","storage":"mongodb"}`.
7. Open your existing admin panel and create a test branch. In Atlas Collections, open database `deltakebab`, collection `dk_collections`, document `_id: "branches"`. Check the `records` array.

## Notes

- `npm run seed` creates predictable demo credentials. Do not use demo credentials in production.
- The existing backend uses one MongoDB document containing a JSON array per logical collection to preserve API compatibility. This is suitable for initial migration, **not** for high-volume production: MongoDB has a 16 MiB document limit and this design rewrites a collection on each change. A later migration should use separate MongoDB documents, indexes, and transactions for scale.
- Existing local JSON data is not removed. Never put `.env` in a public repository or share your MongoDB URI.
