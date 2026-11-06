# ReachInbox Email Job Scheduler

ReachInbox is a TypeScript email scheduling application. The React dashboard submits campaigns to an Express API; PostgreSQL stores the durable schedule; BullMQ and Redis coordinate delayed jobs and worker rate limits; and the worker sends test messages through Ethereal SMTP.

> **Test delivery only:** Ethereal accepts messages into a test mailbox and provides preview links. It does not deliver email to real recipient inboxes.

## Requirements

- Node.js 20 or newer and npm
- Docker Desktop (or compatible Docker Engine) running
- Google OAuth credentials for dashboard sign-in
- An Ethereal test account for SMTP sends
- A Slack app only if you want to test Slack OAuth notifications

## Local setup

From the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run infra:up
npm.cmd run db:migrate
npm.cmd run build:shared
```

Edit `.env` before signing in or running the worker:

### Google OAuth

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL`. Register this redirect URI in Google Cloud Console:

```text
http://localhost:4000/api/auth/google/callback
```

### Ethereal SMTP

Create a test account at [Ethereal Email](https://ethereal.email/) and set:

```dotenv
ETHEREAL_SMTP_HOST=smtp.ethereal.email
ETHEREAL_SMTP_PORT=587
ETHEREAL_SMTP_SECURE=false
ETHEREAL_SMTP_USER=your_ethereal_username
ETHEREAL_SMTP_PASSWORD=your_ethereal_password
```

### Other settings

- `DATABASE_URL`: PostgreSQL connection string. The example uses the local Compose database.
- `REDIS_HOST`, `REDIS_PORT`, and optional `REDIS_PASSWORD`: Redis connection settings.
- `ELASTICSEARCH_NODE`: Elasticsearch endpoint used for email search.
- `SESSION_SECRET`: set a unique random value of at least 32 characters; do not use the development example in a deployed environment.
- `WORKER_CONCURRENCY`: number of jobs a worker can process concurrently (default `5`).
- `DEFAULT_HOURLY_LIMIT` and `DEFAULT_DELAY_BETWEEN_EMAILS_SECONDS`: defaults for sender/composer settings.
- `BULL_BOARD_USER` and `BULL_BOARD_PASSWORD`: credentials protecting Bull Board. Set a non-placeholder password.
- Slack is optional. To enable it, configure SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, and set TOKEN_ENCRYPTION_KEY to a 32-byte base64 string (e.g., node -e " \console.log(require('crypto').randomBytes(32).toString('base64'))\\).

Never commit `.env` or paste credentials into issues or logs. `.env` is ignored by git; use `.env.example` as the safe configuration template.

## Run the application

Open separate PowerShell terminals from the repository root. Infrastructure, migrations, and the shared package build must be ready first.

**Backend API:**

```powershell
npm.cmd run dev:api
```

**BullMQ delivery worker:**

```powershell
npm.cmd run dev:worker
```

Start the worker only after configuring Ethereal. It processes due jobs and can send messages to the Ethereal test mailbox.

**Frontend:**

```powershell
npm.cmd run dev:web
```

Open <http://localhost:5173>. The API is at <http://localhost:4000>, and protected queue monitoring is at <http://localhost:4000/admin/queues>.

For convenience, `npm.cmd run dev` starts the shared-package watcher, API, worker, and frontend together. It also starts the email worker, so use the separate commands if you want to inspect the dashboard/API without processing queued messages.

## Architecture and scheduling

```text
React + Vite dashboard
          │ authenticated HTTP / session cookie
          ▼
Express API ───── PostgreSQL (campaigns, outbox, sessions, attempts)
                         │
                         ├── Elasticsearch (search index)
                         │
                         └── startup reconciliation ──► BullMQ / Redis
                                                           │ delayed jobs
                                                           ▼
                                                   BullMQ worker
                                                     │       │
                                           Redis limits      ├── Ethereal SMTP
                                                     └───────┴── Slack alerts
```

### Scheduling and persistence

1. The dashboard submits the campaign to `POST /api/campaigns` with an `Idempotency-Key`.
2. The API validates the sender and request, then commits the campaign, recipient jobs, attachments, and idempotency record to PostgreSQL in a transaction.
3. Each persisted email job has a stable database ID, which is also its BullMQ job ID. The API creates delayed BullMQ jobs from each recipient's scheduled time.
4. PostgreSQL is the durable outbox. When the worker starts, it scans pending database jobs and reconciles missing queue jobs. A Redis outage after the database commit therefore leaves recoverable work rather than a lost campaign.
5. On a repeated request with the same key and same payload, the API returns the original campaign and attempts to enqueue pending outbox rows again. Reusing the key with different details returns `409`. Keys are scoped to the signed-in user and retained separately from campaign history.
6. If a worker stops during an SMTP attempt and the send outcome cannot be known, the job is marked `UNKNOWN` for review rather than automatically resent. This avoids an unsafe duplicate but may require manual follow-up.

Scheduling uses BullMQ delayed jobs and database reconciliation, **not cron**.

### Rate limiting and concurrency

- `WORKER_CONCURRENCY` sets each worker's BullMQ concurrency (default `5`).
- A campaign's hourly limit and the sender's configured hourly ceiling both apply; the worker enforces the lower value.
- A Redis Lua script atomically reserves the sender's UTC-hour quota and minimum time between sends. This coordinates multiple workers/instances rather than relying on process-local counters.
- The composer controls the per-campaign hourly limit and send delay. A job that reaches a limit is deferred in BullMQ to the next eligible time; it is not dropped.
- With many jobs due together, BullMQ controls concurrency while the Redis reservations spread sends according to the configured per-sender constraints.

## Implemented features

### Backend

- **Scheduler:** authenticated Express APIs, campaign validation, per-recipient BullMQ delayed jobs, and a protected Bull Board queue view.
- **Persistence and recovery:** PostgreSQL campaigns/outbox/attempts, transactional request idempotency, stable job IDs, and worker startup reconciliation.
- **Delivery and state tracking:** configurable worker concurrency, Ethereal SMTP, retry attempts, explicit sent/failed/deferred/cancelled/unknown states, and conservative handling of uncertain SMTP outcomes.
- **Rate limiting:** atomic Redis sender hourly quotas and minimum inter-send delay; limited jobs are deferred.
- **Integrations and search:** Google OAuth sessions, optional Slack OAuth and hourly-limit notifications, and Elasticsearch indexing/search.
- **Sender operations:** sender management, bulk cancellation/rescheduling of pending jobs, and clearing completed history while preserving scheduled/processing jobs.

### Frontend

- **Login:** Google sign-in, user identity/avatar, session-expiration handling, and logout.
- **Dashboard:** scheduled and sent email views, email details/search, sender management, and settings.
- **Compose:** recipient entry and CSV/TXT import, rich message editor, CC/BCC, attachments, start time, send delay, and hourly limit.
- **Tables and feedback:** loading, empty, error, offline, and success states; duplicate-submit prevention; safe scheduling retries using idempotency keys.

## Checks

```powershell
npm.cmd test
npm.cmd run build
```

The focused test suite currently covers idempotency key validation, request fingerprint stability, and Prisma unique-conflict recognition. External OAuth, live Slack delivery, and large-volume/restart scenarios require configured integrations and should be tested separately using disposable data.

## Demo Video

- **Video Link:** `[Insert your demo video link here - e.g., Loom, Google Drive, or YouTube]` *(Max 5 minutes)*
- **Demo Flow Covered:**
  1. Creating and scheduling an email campaign from the frontend dashboard.
  2. Viewing **Scheduled Emails** and live status transitions.
  3. Worker execution, SMTP delivery to Ethereal, and inspecting **Sent Emails** with Ethereal preview URLs.
  4. Server restart resilience test: stopping the server/worker while emails are pending, restarting, and showing that delayed jobs continue on schedule without duplicates.
  5. Rate limit and delay behavior under load (Redis Lua throttling + Slack notification alert).

## Assumptions, Shortcuts, and Trade-offs

1. **SMTP At-Least-Once Delivery vs Exactly-Once:**
   - Standard SMTP does not support distributed two-phase commits. If a network interruption occurs immediately after the remote mail transfer agent (MTA) accepts a message, the local worker cannot be 100% certain of the remote outcome.
   - **Trade-off:** Rather than blindly retrying and risking duplicate emails to real people, the system transitions ambiguous attempts into an explicit `UNKNOWN` state for inspection and records the full attempt log.
2. **Canonical Persistence (PostgreSQL Outbox) vs Redis Queues:**
   - Redis and BullMQ provide high-performance delayed job queues, but Redis is treated as an ephemeral message broker.
   - **Design choice:** PostgreSQL is the single source of truth. Every campaign and recipient outbox row is committed to Postgres first with deterministic UUIDs. On worker startup, a reconciliation routine verifies that any due or pending outbox items exist in BullMQ, preventing job loss during broker outages.
3. **Derived Search Index (Elasticsearch):**
   - Elasticsearch indexes subject lines, bodies, recipients, and senders to power fast multi-field search.
   - **Trade-off:** To prevent stale reads if Elasticsearch temporarily disconnects, PostgreSQL remains primary, and a manual/automated reindexing endpoint (`POST /api/search/reindex`) allows complete index rebuilding from the database.
4. **Rate Limit Defers Rather Than Drops:**
   - When a sender reaches their configured hourly cap, remaining emails are not discarded or marked as hard failures.
   - **Design choice:** BullMQ reschedules the delayed job to the start of the next hourly window (`DEFERRED` state), preserving campaign delivery while strictly respecting outbound provider throttling.
5. **Slack Notification Throttling:**
   - If a campaign has 500 emails that exceed an hourly cap, sending 500 individual Slack messages would flood the channel and trigger Slack API rate limits.
   - **Design choice:** A Redis lock key with a 1-hour expiration ensures only **one** alert is sent to Slack per sender per hourly window.
6. **Ethereal Sandbox:**
   - Real email service providers (SES, SendGrid) require verified domain records (DKIM/SPF) and charge per send.
   - **Design choice:** Ethereal SMTP generates zero spam and creates instant browser preview URLs for immediate visual verification of delivered HTML and attachments.


