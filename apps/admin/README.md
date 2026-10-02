# Pratibha admin panel

The internal panel for running Pratibha: every workspace and its health, plans and
pricing (published once, read by the website, the portal and Saarthi), coupons, the
payment ledger and GST invoices, the unknown caller log and number blocking, the
append-only activity log, platform settings, and the admin team.

It is a separate Next.js app (`apps/admin`, port 3100) with its own users, sessions
and database role. It is never a role, flag or route inside the customer portal.

## How it is kept separate

| | Portal (`apps/web`) | Admin (`apps/admin`) |
| --- | --- | --- |
| Identity | Supabase Auth (GoTrue), `auth.users` | `admin_users`: scrypt password + TOTP two step |
| Session | `sb-…-auth-token` cookie | `__Host-pratibha_admin` cookie, hashed in `admin_sessions`, checked on every request |
| Hostname | `pratibha.tech` | its own hostname (cookies never cross) |
| Database role | `pratibha_app` (RLS) | `pratibha_admin` (BYPASSRLS, no superuser) |
| Admin tables | **no privileges at all** (revoked in the migration) | read/write, except `activity_log` (insert and select only) |

* A portal session presented to the admin app is not a row in `admin_sessions`, so it
  is refused; an admin login is not a GoTrue user, so it cannot open the portal.
* The activity log is append only in the database: a trigger refuses `UPDATE`,
  `DELETE` and `TRUNCATE` for every role, superuser included.
* Roles are enforced at the API (`src/lib/auth/roles.ts`); the UI only explains them.
* Dark launch: with `ADMIN_PANEL_ENABLED` not `true`, every path answers 404.

## Running it locally

```bash
# once: the admin role can log in locally
docker exec -i pratibha-postgres psql -U pratibha -d pratibha -c "ALTER ROLE pratibha_admin LOGIN PASSWORD 'pratibha_admin'"

cp .env.example .env.local          # then fill in (see below)
npm run dev -w apps/admin           # http://localhost:3100

# a first Owner, from the console (prints a one-time invite link)
npm run create-owner -w apps/admin -- --name "Gaurav" --email gaurav@promonkey.tech
```

`scripts/seed-demo.mjs` loads the five workspaces from the boards (local databases only).

### Environment

| Key | |
| --- | --- |
| `ADMIN_PANEL_ENABLED` | `true` to open the panel; anything else answers 404 everywhere |
| `ADMIN_APP_DATABASE_URL` | connection as `pratibha_admin` |
| `ADMIN_SECRET_KEY` | 64 hex chars; seals TOTP secrets (`openssl rand -hex 32`) |
| `ADMIN_BASE_URL` | the panel's own URL, for invite links |
| `PORTAL_BASE_URL` | the portal, for Sign in as and reset links |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | GoTrue admin API: Sign in as, member resets, creating a workspace owner |
| `RESEND_API_KEY`, `RESEND_FROM_DOMAIN` or `ADMIN_EMAIL_FROM` | mail; without a key nothing is sent and the message is logged |
| `INVOICE_SELLER_*`, `INVOICE_NUMBER_PREFIX` | the same seller identity the portal's invoices use |

## Deploying

`./deploy/admin-panel.sh` from the repo root: backs up the code and the database,
syncs, migrates, writes the admin's env on the server, builds, restarts, sets up
nginx and a certificate for the admin hostname, creates the first Owner and smoke
tests. `./deploy/admin-panel.sh rollback <stamp>` puts the previous code back.

## Tests

```bash
npm test -w apps/admin                                   # roles, TOTP (RFC 6238 vectors), passwords, coupons
ADMIN_IT=1 ADMIN_APP_DATABASE_URL=… npx vitest run tests/integration.test.ts   # the build request's done-when checks, against a local database
```

## Decisions taken where the build request left room

* **Existing tables were extended, not duplicated.** `plans` became versioned rows;
  `coupons`, `coupon_redemptions`, `subscriptions` and `tenants` gained columns.
  Added beyond the Data section: `unknown_calls` (the caller log needs a store),
  `users.removed_at/by` (a removed member's jobs and notes still point at them), and
  `subscriptions.top_up_screenings` (the boards sell a screenings pack).
* **Usage rollups** (`usage_daily`) are maintained by triggers on `usage_meters` and
  `interview_calls`, so they move in the same transaction as the meter and survive
  candidate deletion. Days are Asia/Kolkata days.
* **Unknown callers and blocks**: the worker refuses a blocked number at the answer
  webhook, before any stream, and logs every unmatched call with its reason.
* **Delete** needs the typed name, an Owner to ask and a different Owner or Engineer
  to approve; erasure after the 30 day hold keeps the tenant row, its invoices and
  payments (GST records), and the activity log.
* **Out of minutes** is shown, not enforced: the worker records excess minutes as
  overage, as before. Pausing interviews at the cap is a billing decision left open.
* **Platform settings** start at today's behaviour (gates on every plan, the 5000
  character description cap) so the first deploy changes nothing; the designed
  values are for an admin to set. The junk hint, screener seconds and the tuning gate
  are stored and editable but their portal screens do not exist yet.
