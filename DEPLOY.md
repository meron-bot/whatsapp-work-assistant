# Deployment Plan — Running the Assistant for Real on WhatsApp

This document is the full plan. It separates **what I already automated for you**
from **the few things only you can provide** (your secrets, your external
accounts, and a public server — none of which can or should pass through me).

---

## TL;DR — your part is 3 things

1. **Provide credentials** (paste into a `.env` file on your server).
2. **Provide a host** with a public HTTPS URL.
3. **Run two commands** (`make up`, then `make webhook`).

Everything else — Docker images, the full stack, DB migrations, owner seeding,
webhook registration script, health checks, CI — is already built and committed.

---

## What I automated (no action from you)

| Concern | Delivered |
|---|---|
| Build & run the app | `Dockerfile`, `docker/entrypoint.sh` (auto-runs migrations + seed on boot) |
| One-command stack | `docker-compose.full.yml` (app + Postgres + Redis, with volumes & healthchecks) |
| Automatic HTTPS (optional) | `caddy` service + `docker/Caddyfile` (Let's Encrypt, auto-renew) |
| DB schema | `prisma/migrations` applied automatically on deploy |
| Owner record | `src/scripts/seed.ts` (idempotent, from `OWNER_WHATSAPP_NUMBER`) |
| WhatsApp webhook registration | `scripts/register-whatsapp-webhook.sh` (Graph API — no dashboard clicking) |
| Pre-flight validation | `scripts/doctor.sh` (`make check`) |
| Convenience commands | `Makefile` (`up`, `logs`, `migrate`, `seed`, `webhook`, `check`) |
| Continuous testing | `.github/workflows/ci.yml` (Postgres+Redis, typecheck + 41 tests) |
| Config template | `.env.production.example` (every field you must fill is marked `[YOU PROVIDE]`) |

---

## What only YOU can provide (and why I can't)

These require account ownership / billing / your identity, so they cannot be
created programmatically by me, and secrets must never go through me or into git.

### A. Credentials (paste into `.env`)
1. **Meta WhatsApp** — create an app at <https://developers.facebook.com>, add the
   *WhatsApp* product, then copy:
   - `WHATSAPP_ACCESS_TOKEN` (permanent System User token)
   - `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - `META_APP_ID`, `META_APP_SECRET` (App Settings → Basic)
   - `WHATSAPP_VERIFY_TOKEN` — **you invent** any long random string.
2. **Google Cloud** — create an OAuth 2.0 *Web* client; enable Calendar, Tasks,
   Drive, Docs, Gmail APIs. Copy `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Set
   the redirect URI to `https://<your-domain>/auth/google/callback`.
3. **AI keys** — `OPENAI_API_KEY` (speech-to-text + vision) and
   `ANTHROPIC_API_KEY` (planning + drafting).
4. **Secrets you generate** — `GOOGLE_TOKEN_ENCRYPTION_KEY` (`openssl rand -hex 32`)
   and a strong `POSTGRES_PASSWORD`.

### B. A host with public HTTPS
Meta only delivers webhooks to **HTTPS**. Pick one:
- **Easiest (managed HTTPS):** Railway / Render / Fly.io — point them at this repo;
  HTTPS is automatic. Set the env vars in their dashboard.
- **Your own VPS:** any Docker host + a domain → use the built-in Caddy profile
  (`make up-https`) for automatic certificates.
- **Quick test only:** `ngrok http 3000` gives a temporary HTTPS URL.

---

## Step-by-step (VPS / any Docker host)

```bash
# 0. On your server, clone the repo and check out the branch
git clone <repo-url> && cd whatsapp-work-assistant
git checkout claude/cool-bardeen-X8vTx

# 1. Fill in your secrets
cp .env.production.example .env
nano .env                      # fill every [YOU PROVIDE] line

# 2. Validate before starting
make check                     # scripts/doctor.sh

# 3a. Start the stack (app + Postgres + Redis)
make up
#    migrations + owner seed run automatically on container start
#    -> put a TLS proxy in front, OR:

# 3b. ...or start WITH automatic HTTPS (set PUBLIC_DOMAIN in .env, DNS -> this host)
make up-https

# 4. Connect Google (one-time, in your browser)
#    open https://<your-domain>/auth/google  and approve

# 5. Register the WhatsApp webhook with Meta (no dashboard clicks)
make webhook                   # scripts/register-whatsapp-webhook.sh

# 6. Test: send yourself a WhatsApp message. Watch it flow:
make logs
#    Admin dashboard: https://<your-domain>/admin
```

On a managed PaaS, skip Docker: set the env vars in the dashboard, use build
command `npm ci && npx prisma generate && npx tsc -p tsconfig.build.json` and
start command `npx prisma migrate deploy && node dist/scripts/seed.js && node dist/main.js`.
Then run step 4–5 against your PaaS URL.

---

## How to hand me the secrets safely

Do **not** paste real tokens into the chat or commit them. Options:
- You set them yourself on the server / PaaS dashboard (recommended).
- If you want me to drive a deploy, store them in the platform's secret manager
  (GitHub Actions secrets, Railway/Render env vars) and I work against those
  references — never the raw values.

I will gladly wire up anything else (a GitHub Actions deploy workflow to your
chosen PaaS, S3/Drive production storage, etc.) — just tell me the target.
