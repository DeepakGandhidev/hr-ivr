# Pratibha v2 — Multi-tenant inbound hiring agent

Pratibha v2 is a standalone multi-tenant SaaS where any registered company runs its own hiring pipeline:

```
Register → Connect Email → JD → Post → Screen → Approve → Interview → Report
```

This repo contains the P0 implementation: pipeline without portals.

## Repo structure

```
pratibha/
├── apps/
│   ├── web/        # Next.js 14 + TypeScript UI and API
│   └── worker/     # Voice agent + ingestion worker (Node.js)
├── packages/
│   ├── prisma/     # Prisma schema + generated client
│   └── shared/     # Roles, authz, validation, constants, audit helpers
├── docker-compose.yml
└── package.json    # npm workspaces
```

## Run it with Docker

Everything in containers — Postgres, Supabase auth, the web app and the voice
worker. Docker is the only thing you need installed.

```bash
git clone https://github.com/DeepakGandhidev/hr-ivr.git
cd hr-ivr
cp .env.docker.example .env.docker      # then add the model API key
docker compose -f docker-compose.dev.yml up
```

First run takes a few minutes (image build, then GoTrue and Prisma migrations).
When it settles:

| | | |
|---|---|---|
| Web app | http://localhost:3000 | |
| Worker | http://localhost:8091 | |
| Supabase Studio | http://localhost:54323 | browse and query the database |
| Mailpit | http://localhost:8025 | every email the app sends, caught locally |
| Auth (GoTrue) | http://localhost:9999 | |
| Postgres | `postgres://pratibha:pratibha@localhost:5432/pratibha` | |

Supabase runs as containers here, not through the Supabase CLI, so nothing
extra has to be installed. Only auth and the database are included: this app
uses Supabase for sign-in and Prisma for everything else, so PostgREST, Storage
and Realtime would be nine containers nobody calls. Studio's API-shaped tabs
are therefore empty; its table editor and SQL editor are the point.

Mail is never delivered locally. Invites, rejections and verification mail all
land in Mailpit, so a dev machine cannot email a real candidate by accident.

Migrations run automatically, in their own container, before either service
starts — so neither ever comes up against a schema that does not exist yet.

`.env.docker.example` ships with `MOCK_MODE=true`, which mocks speech and
telephony: the conversation loop can be exercised with no Sarvam or Plivo
credentials. **The one value worth filling in is `ANTHROPIC_API_KEY`**, without
which CV screening and interviews cannot run. Ask Deepak for it — and note that
`.env.docker` is gitignored, so never paste a key into `.env.docker.example`.

Seed a demo tenant and login users once it is up:

```bash
docker compose -f docker-compose.dev.yml exec web npm run db:seed
docker compose -f docker-compose.dev.yml exec web npm run db:mock
```

Source is bind-mounted and both services hot-reload, so an edit on your machine
takes effect without rebuilding. Rebuild only when a dependency changes:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Useful:

```bash
docker compose -f docker-compose.dev.yml logs -f web worker   # follow logs
docker compose -f docker-compose.dev.yml down                 # stop, keep data
docker compose -f docker-compose.dev.yml down -v              # stop, WIPE the database
```

`down -v` deletes the Postgres volume. That is also the only way to re-run
`docker/postgres-init.sql`, which sets up the restricted `pratibha_app` role
and the `auth` schema — it runs once, on an empty data directory.

## Quick start

1. Start Postgres and local Supabase:
   ```bash
   docker compose up -d
   supabase start
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy env files and fill in credentials:
   ```bash
   cp apps/web/.env.local.example apps/web/.env.local
   cp apps/worker/.env.example apps/worker/.env
   cp .env.example .env
   ```

4. Set up the database, then load the demo tenant:
   ```bash
   npm run db:generate
   npm run db:reset      # migrate + seed plans/prompts + mock data + login users
   ```

5. Run the dev stack:
   ```bash
   npm run dev
   ```
   - Web app: http://localhost:3000
   - Worker:  http://localhost:8091

### Signing in

`npm run db:mock:auth` creates local Supabase Auth users for the demo tenants.
All of them share the password `pratibha123`:

| Email                | Role     | Workspace |
| -------------------- | -------- | --------- |
| `owner@acme.test`    | owner    | `/acme`   |
| `admin@acme.test`    | admin    | `/acme`   |
| `reviewer@acme.test` | reviewer | `/acme`   |
| `viewer@acme.test`   | viewer   | `/acme`   |
| `owner@globex.test`  | owner    | `/globex` |

Globex exists so tenant isolation is visible in the UI and provable in the
regression suite — a cross-tenant read is a P0 bug (§3).

### What the mock data contains

`npm run db:mock` is idempotent and covers every stage of §5:

- Two tenants; an open role with an approved JD and a draft role still behind
  Gate G1
- A connected forward alias and a broken Gmail connection (error banner)
- Six candidates: five screened across the threshold, one with a failed CV parse
- An approved shortlist (three approved, one removed by a reviewer) and the
  invites sent under that approval
- Four calls: two completed with assessment reports, one dropped, one unknown
  caller — plus the usage meter and violation log entries they produce

To walk a candidate through a live interview against the model:

```bash
npm run simulate -w @pratibha/worker -- +919900112233 normal
```

## Database roles

Two connections, deliberately:

- `pratibha` (owner/superuser) — migrations, seeds, and the **worker**, which
  reads across tenants for caller recognition and so must bypass RLS.
- `pratibha_app` (NOSUPERUSER) — the **web app** request path. A superuser
  bypasses row-level security even with `FORCE ROW LEVEL SECURITY`, so the app
  must not connect as one, or the policies are inert.

`ADMIN_DATABASE_URL` is the narrow exception: it resolves the session's user and
tenant before a tenant context exists, and serves the public careers page. It is
not filtered by RLS — widen its use only as you would a security boundary.

## Outreach email

Invites (§5 Stage 7) send through Resend, addressed per tenant as
`{tenant-slug}@$RESEND_FROM_DOMAIN` with reply-to set to the tenant's connected
hiring inbox, so candidate replies reach the company rather than a Pratibha
mailbox.

```
RESEND_API_KEY=...              # send-only key
RESEND_FROM_DOMAIN=mail.pratibha.tech
```

The domain must be **verified in Resend** — an unverified sender is rejected
with a 403 at send time, not at boot.

**With no `RESEND_API_KEY`, sending is log-only**: `sendEmail` prints the
rendered message and reports success, so no candidate can be contacted by
accident. That is the right default for any environment holding real candidate
data that you are not ready to email.

## Model provider

Screening, JD drafting, the on-call interviewer and the post-call assessment all
speak the Anthropic Messages API, pointed at Moonshot's Kimi endpoint:

```
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_MODEL=kimi-k2.6
ANTHROPIC_ANALYSIS_MODEL=kimi-k2.6
```

Any endpoint speaking that API works; leave `ANTHROPIC_BASE_URL` unset to talk
to Anthropic directly. Kimi runs with thinking on by default, which rejects the
`tool_choice` shape the assessment uses and costs seconds per turn, so it is
disabled per-model (`sampling.js` in the worker, `llm.ts` in the web app — keep
the two in step).

Set `MOCK_MODE=true` to run screening and JD drafting with no provider account
and no spend.

## P0 scope

- Multi-tenant signup with Supabase Auth
- Tenant isolation via Postgres RLS + API authz
- JD Studio with approval gate (G1)
- Careers page publishing
- Email ingestion (forward alias + polling stub)
- Manual CV intake: bulk import up to 100 CVs at a time, or type details in
- CV screening with quota enforcement
- Shortlist approval gate (G2)
- Interview invite gate enforcement
- Tenant-aware inbound interview engine
- Usage metering and trial hard-stops
- Audit / violation logging
- Authz regression suite

## Out of scope (P1/P2)

- Razorpay subscriptions, overage billing, trial expiry automation
- Outlook OAuth, IMAP, LinkedIn posting, Naukri integration
- Dedicated DIDs per Scale tenant
- Admin console UI, API + webhooks, Saarthi assistant
- Daily rollup dashboards

## Important BRD constraints

- Inbound-only calling. No outbound calls.
- Human approval gate before any candidate contact.
- Server-side authorization on every endpoint.
- All tunable behavior lives in the database.
- Cost and observability are first-class.
