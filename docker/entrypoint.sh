#!/bin/sh
set -e

echo "[entrypoint] Applying database migrations..."
npx prisma migrate deploy

echo "[entrypoint] Seeding owner record (idempotent)..."
node dist/scripts/seed.js || echo "[entrypoint] seed skipped/failed (non-fatal)"

echo "[entrypoint] Starting application..."
exec node dist/main.js
