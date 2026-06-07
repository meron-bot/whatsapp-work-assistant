#!/bin/sh
# Note: intentionally NOT using `set -e`. We want the HTTP server to start even
# if migrations fail, so the service comes online and /status can report what is
# actually broken (instead of crash-looping with no visibility).

echo "[entrypoint] Applying database migrations..."
# Bound with a timeout so an unreachable DB cannot hang startup past the
# platform healthcheck window; the app starts regardless and /status reports it.
if timeout 60 npx prisma migrate deploy; then
  echo "[entrypoint] Migrations applied."
else
  echo "[entrypoint] WARNING: migrations failed/timed out (continuing so the app can start and report status)."
fi

echo "[entrypoint] Seeding owner record (idempotent)..."
node dist/scripts/seed.js || echo "[entrypoint] seed skipped/failed (non-fatal)"

echo "[entrypoint] Starting application..."
exec node dist/main.js
