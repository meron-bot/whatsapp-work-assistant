#!/usr/bin/env bash
#
# Automatically registers the WhatsApp webhook with Meta via the Graph API,
# so you do NOT have to click through the Meta dashboard's webhook config.
#
# Prerequisites in your .env:
#   META_APP_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_VERIFY_TOKEN,
#   WHATSAPP_BUSINESS_ACCOUNT_ID, APP_BASE_URL (public HTTPS)
#
# Usage:  ./scripts/register-whatsapp-webhook.sh
set -euo pipefail

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

: "${META_APP_ID:?set META_APP_ID in .env}"
: "${WHATSAPP_ACCESS_TOKEN:?set WHATSAPP_ACCESS_TOKEN in .env}"
: "${WHATSAPP_VERIFY_TOKEN:?set WHATSAPP_VERIFY_TOKEN in .env}"
: "${WHATSAPP_BUSINESS_ACCOUNT_ID:?set WHATSAPP_BUSINESS_ACCOUNT_ID in .env}"
: "${APP_BASE_URL:?set APP_BASE_URL (public https) in .env}"

GRAPH="https://graph.facebook.com/v21.0"
CALLBACK="${APP_BASE_URL%/}/webhooks/whatsapp"

echo "==> Subscribing app ${META_APP_ID} webhook -> ${CALLBACK}"
curl -fsS -X POST "${GRAPH}/${META_APP_ID}/subscriptions" \
  -H "Authorization: Bearer ${WHATSAPP_ACCESS_TOKEN}" \
  -d "object=whatsapp_business_account" \
  -d "callback_url=${CALLBACK}" \
  -d "verify_token=${WHATSAPP_VERIFY_TOKEN}" \
  -d "fields=messages"
echo

echo "==> Subscribing WABA ${WHATSAPP_BUSINESS_ACCOUNT_ID} to the app"
curl -fsS -X POST "${GRAPH}/${WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps" \
  -H "Authorization: Bearer ${WHATSAPP_ACCESS_TOKEN}"
echo

echo "==> Done. Send yourself a WhatsApp message to test."
