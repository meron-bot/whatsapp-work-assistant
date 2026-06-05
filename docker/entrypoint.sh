#!/bin/sh
# Note: intentionally NOT using `set -e`. We want the HTTP server to start even
# if migrations fail, so the service comes online and /status can report what is
# actually broken (instead of crash-looping with no visibility).

echo "[entrypoint] Applying database migrations..."
if npx prisma migrate deploy; then
  echo "[entrypoint] Migrations applied."
else
  echo "[entrypoint] WARNING: migrations failed (continuing so the app can start and report status)."
fi

echo "[entrypoint] Seeding owner record (idempotent)..."
node dist/scripts/seed.js || echo "[entrypoint] seed skipped/failed (non-fatal)"

echo "[entrypoint] Starting application..."
exec node dist/main.js
