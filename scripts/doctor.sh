#!/usr/bin/env bash
#
# Pre-flight check: verifies your .env is complete and that Postgres/Redis are
# reachable, before you start the stack.
#
# Usage:  ./scripts/doctor.sh
set -uo pipefail

ENV_FILE="${1:-.env}"
ok=0; warn=0; err=0
check_ok()   { echo "  ✅ $1"; }
check_warn() { echo "  ⚠️  $1"; warn=$((warn+1)); }
check_err()  { echo "  ❌ $1"; err=$((err+1)); }

echo "== Work Assistant doctor =="

if [ ! -f "$ENV_FILE" ]; then
  check_err "$ENV_FILE not found. Run: cp .env.production.example .env"
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

echo "-- required secrets --"
for v in OWNER_WHATSAPP_NUMBER WHATSAPP_VERIFY_TOKEN WHATSAPP_ACCESS_TOKEN \
         WHATSAPP_PHONE_NUMBER_ID OPENAI_API_KEY ANTHROPIC_API_KEY \
         GOOGLE_TOKEN_ENCRYPTION_KEY; do
  val="${!v:-}"
  if [ -z "$val" ] || echo "$val" | grep -qiE 'change_me|XXXX|your-|\.\.\.'; then
    check_err "$v is empty or placeholder"
  else
    check_ok "$v set"
  fi
done

echo "-- optional (recommended) --"
for v in META_APP_SECRET META_APP_ID GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  val="${!v:-}"
  if [ -z "$val" ] || echo "$val" | grep -qiE 'change_me|XXXX|your-|\.\.\.'; then
    check_warn "$v not set"
  else
    check_ok "$v set"
  fi
done

echo "-- connectivity --"
if command -v pg_isready >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  pg_isready -d "$DATABASE_URL" >/dev/null 2>&1 && check_ok "Postgres reachable" || check_warn "Postgres not reachable yet (will start with compose)"
fi
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli ${REDIS_URL:+-u "$REDIS_URL"} ping >/dev/null 2>&1 && check_ok "Redis reachable" || check_warn "Redis not reachable yet (will start with compose)"
fi

echo "== $err error(s), $warn warning(s) =="
[ "$err" -eq 0 ] && echo "Looks good — you can start the stack." || echo "Fix the errors above first."
exit $([ "$err" -eq 0 ] && echo 0 || echo 1)
