# Render Setup — Click-by-Click

This is the exact, copy-paste path to get the assistant live on WhatsApp using
the `render.yaml` blueprint in this repo. No CLI required.

> Secrets are entered in the Render dashboard only — never committed to git.

## 1. Create the Blueprint
1. Sign in at <https://dashboard.render.com>.
2. **New → Blueprint**.
3. Connect the GitHub repo `meron-bot/whatsapp-work-assistant`, branch
   `claude/cool-bardeen-X8vTx`.
4. Render reads `render.yaml` and shows it will create: a **web service**, a
   **Postgres** database, and a **Redis** instance. Click **Apply**.

`DATABASE_URL`, `REDIS_URL` and `GOOGLE_TOKEN_ENCRYPTION_KEY` are wired/generated
automatically. Everything else marked `sync: false` you enter in step 3.

## 2. Note your public URL
After creation the web service gets a URL like
`https://work-assistant-XXXX.onrender.com`. Copy it — call it `<APP_URL>`.

## 3. Set environment variables (web service → Environment)

| Key | Value |
|-----|-------|
| `APP_BASE_URL` | `<APP_URL>` |
| `GOOGLE_REDIRECT_URI` | `<APP_URL>/auth/google/callback` |
| `OWNER_WHATSAPP_NUMBER` | your personal number, digits only (e.g. `9725...`) |
| `WHATSAPP_VERIFY_TOKEN` | the random token you were given |
| `WHATSAPP_ACCESS_TOKEN` | your Meta token (prefer a permanent System User token) |
| `WHATSAPP_PHONE_NUMBER_ID` | from Meta |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | from Meta |
| `META_APP_ID` | from Meta |
| `META_APP_SECRET` | from Meta → App Settings → Basic |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `OPENAI_API_KEY` | your OpenAI key (needed for voice notes + images) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional — for Calendar/Drive/Docs/Gmail |

Click **Save** → Render redeploys. Migrations + owner seeding run automatically
on boot (see `docker/entrypoint.sh`).

## 4. Add your phone as an allowed recipient (test numbers only)
In the Meta WhatsApp dashboard → **API Setup**, add your personal number to the
recipient list so the test business number can message you.

## 5. Connect Google (optional, one-time)
Open `<APP_URL>/auth/google` in your browser and approve. Make sure
`<APP_URL>/auth/google/callback` is listed as an authorized redirect URI in your
Google Cloud OAuth client.

## 6. Register the WhatsApp webhook (no dashboard clicking)
From your machine with the repo + a filled `.env` (or set the vars inline):

```bash
bash scripts/register-whatsapp-webhook.sh
```

This points Meta at `<APP_URL>/webhooks/whatsapp` with your verify token and
subscribes to the `messages` field via the Graph API.

## 7. Test
Send a WhatsApp message from your phone to the business number, e.g.
`תזכיר לי מחר בשעה 10 לשלוח לאבי את ההצעה`. You should get a Hebrew confirmation.
Watch activity at `<APP_URL>/admin`.

## Security reminder
Any token/secret that was ever shared in a chat should be **rotated** after
setup (Meta App Secret, Anthropic key, OpenAI key, WhatsApp token).
