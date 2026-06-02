# WhatsApp Work Assistant

A **private, single-owner work-execution assistant** that lives inside WhatsApp.
It turns every incoming message (text, voice note, image, video, document) into a
tracked outcome — a task, calendar event, reminder, document draft, saved file,
**pending clarification**, **pending approval**, or an explicitly-ignored item with
a reason. Nothing actionable is ever silently dropped, and the assistant **never
invents information**.

> The assistant talks to the owner in **Hebrew**. Official company documents are
> drafted in professional **English** unless told otherwise.

---

## 1. What the assistant does

- Receives WhatsApp messages from a single owner (allowlisted phone number).
- Transcribes voice notes, runs vision/OCR on images, stores all originals.
- Plans an action with an AI planner whose output is **validated by Zod**.
- **Asks a clear clarification question** whenever information is missing,
  ambiguous, contradictory, or low-confidence — and waits for the answer (text
  **or** voice note).
- **Requires explicit approval** before any external/sensitive action (emails,
  invites, sharing, official reports, deletions, changing existing data).
- Creates private tasks/reminders, proposes calendar events, drafts English
  documents, saves media to Drive, and tracks **open loops** for unfinished work.
- Sends daily planning briefings (morning / midday / end-of-day) and dispatches
  reminders every minute.
- Exposes a minimal admin dashboard.

## 2. Architecture overview

```
WhatsApp Cloud API ──▶ POST /webhooks/whatsapp ──▶ store (idempotent) ──▶ BullMQ queue
                                                                              │
                                                                              ▼
                                                                  MessageProcessor
                          ┌───────────────────────────────────────────┼───────────────────────────┐
                          ▼                       ▼                     ▼                           ▼
                  Media (transcribe/        Pending approval/     Planner (Zod-validated)     Action Executor
                  vision, store original)   clarification routing   anti-hallucination        (policy-gated)
                                                                                                   │
                          ┌──────────────────────────────────────────────────────────────────────┤
                          ▼            ▼            ▼             ▼              ▼                  ▼
                       Tasks       Reminders   Calendar      Documents      Open loops        Approvals/
                    (Google Tasks)            (Google Cal)  (Docs/Drive)                      Clarifications
```

- **NestJS + TypeScript**, **PostgreSQL + Prisma**, **Redis + BullMQ**.
- AI behind a provider abstraction (OpenAI for STT/vision, Anthropic/OpenAI for
  planning & drafting). All AI output is Zod-validated; invalid output falls back
  to a safe clarification.
- See `src/` for module layout (`whatsapp`, `media`, `ai`, `planner`, `actions`,
  `clarifications`, `approvals`, `google`, `documents`, `reminders`, `open-loops`,
  `scheduler`, `admin`).

## 3. Setup requirements

- Node.js 20+
- Docker + Docker Compose (for Postgres & Redis)
- A Meta WhatsApp Business app
- A Google Cloud project with OAuth credentials
- OpenAI and/or Anthropic API keys

## 4. Create a Meta WhatsApp app

1. Go to <https://developers.facebook.com/> → **Create App** → *Business*.
2. Add the **WhatsApp** product. Note the **Phone Number ID** and
   **Business Account ID**.
3. Generate a **permanent access token** (System User token) → `WHATSAPP_ACCESS_TOKEN`.
4. Under **App Settings → Basic**, copy the **App Secret** → `META_APP_SECRET`.

## 5. Configure the WhatsApp webhook

1. Expose your local server (e.g. `ngrok http 3000`).
2. In **WhatsApp → Configuration**, set the callback URL to
   `https://<host>/webhooks/whatsapp` and the **Verify Token** to the value of
   `WHATSAPP_VERIFY_TOKEN`.
3. Subscribe to the **messages** field.
4. Meta calls `GET /webhooks/whatsapp` to verify; the app echoes the challenge.

## 6. Configure Google OAuth

1. In Google Cloud Console, create an **OAuth 2.0 Client ID** (Web application).
2. Add the redirect URI `http://localhost:3000/auth/google/callback`
   (`GOOGLE_REDIRECT_URI`).
3. Enable the Calendar, Tasks, Drive, Docs and Gmail APIs.
4. Start the app and visit `http://localhost:3000/auth/google` to connect. The
   refresh token is stored **encrypted** (AES-256-GCM) in the database.

Scopes are least-privilege: `calendar.events`, `calendar.readonly`, `tasks`,
`drive.file`, `documents`, `gmail.compose`, `gmail.send`.

## 7. Required environment variables

See [`.env.example`](./.env.example). Validated on startup by `src/config/env.ts`
— the app refuses to boot if anything required is missing.

## 8. Run locally with Docker Compose

```bash
cp .env.example .env        # then fill in real values
docker compose up -d        # Postgres + Redis
npm install
npm run prisma:generate
npm run prisma:migrate      # creates the schema
npm run start:dev
```

## 9. Prisma migrations

```bash
npm run prisma:migrate      # dev: create + apply a migration
npm run prisma:deploy       # prod: apply existing migrations
npm run prisma:studio       # inspect data
```

## 10. Tests

```bash
npm test
```

Covers webhook verification, idempotency, text/audio parsing, the audio pipeline,
clarification creation + answering (text & voice), approval creation/approve/
reject/ambiguous, low-confidence planning, missing-field clarifications, task &
calendar policy, document anti-hallucination, Zod-failure fallback, and audit
logging.

## 11. Deploy

- Build: `npm run build`, run: `npm run start:prod`.
- Provide managed Postgres + Redis, set `NODE_ENV=production`, real secrets, and a
  strong `GOOGLE_TOKEN_ENCRYPTION_KEY` (32+ bytes).
- Set `STORAGE_PROVIDER=drive` (or `s3`) for production media.
- Terminate TLS in front of the app and point the Meta webhook at the public URL.

## 12. Security notes

- **Owner allowlist**: only `OWNER_WHATSAPP_NUMBER` can drive the assistant.
- **Webhook signature** verified against `META_APP_SECRET` (`X-Hub-Signature-256`).
- **Encrypted** Google refresh tokens; **least-privilege** OAuth scopes.
- **No secrets in logs** (structured logger redacts sensitive keys).
- Internal errors are never surfaced to WhatsApp.
- Queue retries with exponential backoff + dead-letter surfaced in the admin UI.

## 13. Approval policy

| Risk | Examples | Behaviour |
|------|----------|-----------|
| Low (private) | private task, reminder, save note/media, private draft | auto-execute if confidence ≥ 0.85 and required fields exist |
| Medium | calendar event w/o external guests, formal draft, moving files | confirm / pending approval |
| High | send email/WhatsApp, invite others, share doc, official report, delete, modify existing event/deadline, contact client/supplier/employee/manager | **always** a pending approval |

High-risk actions are **never executed** until the owner replies `אשר`/`כן`/`שלח`
(text or voice). Ambiguous answers re-prompt; nothing happens on `בטל`/`לא`.

## 14. Clarification behaviour

When information is missing the assistant creates a `PendingClarification`, sends a
**specific** Hebrew question (multiple-choice when possible), and waits. The next
message (text or transcribed voice) is matched to the oldest open clarification and
the previously-blocked action is re-planned and continued.

## 15. Anti-hallucination rules

- Never invent dates, times, participants, contacts, projects, clients, prices,
  quantities, contractual facts, policy, promises, send/approval status, or file
  destinations.
- Missing values are `null` in the structured output and trigger a clarification.
- Confidence gating: `≥0.85` auto-execute private; `0.60–0.84` draft/confirm;
  `<0.60` clarify; any external/sensitive action → approval regardless.
- Documents use `[Missing: …]` placeholders and surface missing facts instead of
  fabricating wording; originals/transcripts are preserved in an appendix.
- If the AI returns invalid/unvalidatable output, the planner falls back to a safe
  clarification rather than guessing.
```
