-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "PlanVisibility" AS ENUM ('public', 'hidden');

-- CreateEnum
CREATE TYPE "TopupPackKind" AS ENUM ('minutes', 'screenings');

-- CreateEnum
CREATE TYPE "PricingRowStatus" AS ENUM ('draft', 'published', 'retired');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('draft', 'scheduled', 'active', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('owner', 'engineer', 'support');

-- CreateEnum
CREATE TYPE "AdminSessionStage" AS ENUM ('awaiting_code', 'active');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('subscription', 'top_up', 'goodwill', 'refund');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('captured', 'failed', 'refunded', 'scheduled_retry');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('admin', 'workspace', 'system');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TenantStatus" ADD VALUE 'past_due';
ALTER TYPE "TenantStatus" ADD VALUE 'deleted_pending';
ALTER TYPE "TenantStatus" ADD VALUE 'deleted';

-- DropIndex
DROP INDEX "plans_name_key";

-- AlterTable
ALTER TABLE "coupon_redemptions" ADD COLUMN     "discount_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payment_id" TEXT;

-- AlterTable
ALTER TABLE "coupons" ADD COLUMN     "applicable_plans" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "ended_at" TIMESTAMP(3),
ADD COLUMN     "starts_at" TIMESTAMP(3),
ADD COLUMN     "status" "CouponStatus" NOT NULL DEFAULT 'active';

-- (plans: see the hand-written block at the end)

-- AlterTable
ALTER TABLE "users" ADD COLUMN "removed_at" TIMESTAMP(3),
ADD COLUMN "removed_by" TEXT;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "top_up_screenings" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "deletion_hold_until" TIMESTAMP(3),
ADD COLUMN     "deletion_requested_at" TIMESTAMP(3),
ADD COLUMN     "deletion_requested_by" TEXT,
ADD COLUMN     "previous_status" "TenantStatus",
ADD COLUMN     "status_changed_at" TIMESTAMP(3),
ADD COLUMN     "status_changed_by" TEXT;

-- CreateTable
CREATE TABLE "topup_packs" (
    "id" TEXT NOT NULL,
    "kind" "TopupPackKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price_inr" INTEGER NOT NULL,
    "validity_days" INTEGER NOT NULL,
    "status" "PricingRowStatus" NOT NULL DEFAULT 'draft',
    "replaces_id" TEXT,
    "retire_on_publish" BOOLEAN NOT NULL DEFAULT false,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topup_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_config" (
    "id" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "days" INTEGER NOT NULL,
    "screenings" INTEGER NOT NULL,
    "job_limit" INTEGER NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'draft',
    "published_by" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "AdminRole" NOT NULL,
    "totp_secret" TEXT,
    "totp_enabled_at" TIMESTAMP(3),
    "last_active_at" TIMESTAMP(3),
    "invite_token_hash" TEXT,
    "invite_expires_at" TIMESTAMP(3),
    "invited_by" TEXT,
    "deactivated_at" TIMESTAMP(3),
    "deactivated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "stage" "AdminSessionStage" NOT NULL DEFAULT 'awaiting_code',
    "code_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "description" TEXT NOT NULL,
    "plan_id" TEXT,
    "pack_id" TEXT,
    "minutes" INTEGER,
    "screenings" INTEGER,
    "invoice_id" TEXT,
    "coupon_id" TEXT,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "refund_of_id" TEXT,
    "reason" TEXT,
    "retry_at" TIMESTAMP(3),
    "reference" TEXT,
    "recorded_by" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "target_workspace_id" TEXT,
    "target_workspace_name" TEXT,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_daily" (
    "tenant_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "screenings" INTEGER NOT NULL DEFAULT 0,
    "interviews" INTEGER NOT NULL DEFAULT 0,
    "calls_completed" INTEGER NOT NULL DEFAULT 0,
    "calls_no_show" INTEGER NOT NULL DEFAULT 0,
    "calls_dropped" INTEGER NOT NULL DEFAULT 0,
    "calls_out_of_window" INTEGER NOT NULL DEFAULT 0,
    "calls_declined_consent" INTEGER NOT NULL DEFAULT 0,
    "calls_unknown_caller" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("tenant_id","day")
);

-- CreateTable
CREATE TABLE "unknown_calls" (
    "id" TEXT NOT NULL,
    "caller_number" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason_code" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "tenant_id" TEXT,
    "candidate_id" TEXT,
    "interview_call_id" TEXT,

    CONSTRAINT "unknown_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_numbers" (
    "id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "blocked_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "last_hit_at" TIMESTAMP(3),
    "unblocked_at" TIMESTAMP(3),
    "unblocked_by" TEXT,

    CONSTRAINT "blocked_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "topup_packs_status_idx" ON "topup_packs"("status");

-- CreateIndex
CREATE INDEX "trial_config_status_published_at_idx" ON "trial_config"("status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_invite_token_hash_key" ON "admin_users"("invite_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_user_id_idx" ON "admin_sessions"("admin_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_invoice_id_key" ON "payments"("invoice_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_paid_at_idx" ON "payments"("tenant_id", "paid_at");

-- CreateIndex
CREATE INDEX "payments_status_paid_at_idx" ON "payments"("status", "paid_at");

-- CreateIndex
CREATE INDEX "activity_log_at_idx" ON "activity_log"("at");

-- CreateIndex
CREATE INDEX "activity_log_target_workspace_id_at_idx" ON "activity_log"("target_workspace_id", "at");

-- CreateIndex
CREATE INDEX "activity_log_actor_type_at_idx" ON "activity_log"("actor_type", "at");

-- CreateIndex
CREATE INDEX "activity_log_action_idx" ON "activity_log"("action");

-- CreateIndex
CREATE INDEX "usage_daily_day_idx" ON "usage_daily"("day");

-- CreateIndex
CREATE INDEX "unknown_calls_caller_number_at_idx" ON "unknown_calls"("caller_number", "at");

-- CreateIndex
CREATE INDEX "unknown_calls_at_idx" ON "unknown_calls"("at");

-- CreateIndex
CREATE INDEX "blocked_numbers_phone_e164_idx" ON "blocked_numbers"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_payment_id_key" ON "coupon_redemptions"("payment_id");

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below this line.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Plans become versioned rows.
--
-- Existing rows become version 1, published, of the plan family named by their
-- id. Their limits are backfilled from the figures the portal has been
-- enforcing (packages/shared PLANS), which are the truth customers are on
-- today; the jsonb `limits` is kept in step for the worker, which reads it.
-- ---------------------------------------------------------------------------
ALTER TABLE "plans"
  ADD COLUMN "key" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "slashed_price_inr" INTEGER,
  ADD COLUMN "interview_minutes" INTEGER,
  ADD COLUMN "screenings" INTEGER,
  ADD COLUMN "job_limit" INTEGER,
  ADD COLUMN "visibility" "PlanVisibility" NOT NULL DEFAULT 'public',
  ADD COLUMN "status" "PlanStatus" NOT NULL DEFAULT 'published',
  ADD COLUMN "published_by" TEXT,
  ADD COLUMN "published_at" TIMESTAMP(3);

UPDATE "plans" SET "key" = CASE WHEN id IN ('starter', 'growth', 'scale') THEN id ELSE lower(name) END;

UPDATE "plans" SET
  "interview_minutes" = CASE "key"
    WHEN 'starter' THEN 150 WHEN 'growth' THEN 600 WHEN 'scale' THEN 2000
    ELSE COALESCE((limits->>'interviewMinutes')::int, 0) END,
  "screenings" = CASE "key"
    WHEN 'starter' THEN 100 WHEN 'growth' THEN 400 WHEN 'scale' THEN 1500
    ELSE COALESCE((limits->>'screenings')::int, 0) END,
  "job_limit" = CASE "key"
    WHEN 'starter' THEN 2 WHEN 'growth' THEN 6 WHEN 'scale' THEN NULL
    ELSE NULLIF(limits->>'roles', '')::int END,
  -- The struck-through "was" prices the public website shows today, so that
  -- the website, once it reads published pricing, shows exactly what it does now.
  "slashed_price_inr" = CASE "key"
    WHEN 'starter' THEN 9999 WHEN 'growth' THEN 25999 WHEN 'scale' THEN 59999
    ELSE NULL END,
  "published_at" = created_at;

UPDATE "plans" SET limits = limits || jsonb_build_object(
  'interviewMinutes', "interview_minutes",
  'screenings', "screenings",
  'roles', "job_limit");

ALTER TABLE "plans"
  ALTER COLUMN "key" SET NOT NULL,
  ALTER COLUMN "interview_minutes" SET NOT NULL,
  ALTER COLUMN "screenings" SET NOT NULL;

CREATE UNIQUE INDEX "plans_key_version_key" ON "plans"("key", "version");
-- At most one unpublished edit per plan.
CREATE UNIQUE INDEX "plans_one_draft_per_key" ON "plans"("key") WHERE "status" = 'draft';

-- ---------------------------------------------------------------------------
-- Coupons: carry the old boolean into the new lifecycle. An inactive code
-- becomes paused rather than ended, because ended is irreversible and nobody
-- decided that.
-- ---------------------------------------------------------------------------
UPDATE "coupons" SET "status" = CASE
  WHEN NOT active THEN 'paused'::"CouponStatus"
  WHEN expires_at IS NOT NULL AND expires_at < now() THEN 'ended'::"CouponStatus"
  ELSE 'active'::"CouponStatus" END;
UPDATE "coupons" SET "ended_at" = expires_at WHERE "status" = 'ended';

-- One active block per number; history stays.
CREATE UNIQUE INDEX "blocked_numbers_active_phone" ON "blocked_numbers"("phone_e164") WHERE "unblocked_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Published pricing that used to live in code: the trial and the top up packs.
-- Seeded from the values the portal serves today, so publishing nothing
-- changes nothing.
-- ---------------------------------------------------------------------------
INSERT INTO "trial_config" (id, minutes, days, screenings, job_limit, status, published_at)
VALUES ('trial-v1', 50, 15, 25, 1, 'published', now());

INSERT INTO "topup_packs" (id, kind, quantity, price_inr, validity_days, status, published_at) VALUES
  ('pack-100-min',  'minutes', 100,  1200,  90, 'published', now()),
  ('pack-300-min',  'minutes', 300,  3300,  90, 'published', now()),
  ('pack-1000-min', 'minutes', 1000, 10000, 90, 'published', now());

-- ---------------------------------------------------------------------------
-- Platform settings. Defaults are today's behaviour, so the first deploy moves
-- nothing; the designed values are an admin's decision to make in the panel.
-- ---------------------------------------------------------------------------
INSERT INTO "platform_settings" (key, value) VALUES
  ('screening.suggest_threshold', '70'),
  ('pipeline.junk_hint', 'true'),
  ('report.score_gap_threshold', '2.0'),
  ('interview.screener_seconds', '30'),
  ('lists.page_size', '25'),
  ('company.description_cap', '5000'),
  ('gate.portal_posts', '"all"'),
  ('gate.interview_tuning', '"all"'),
  -- Admin panel configuration, not shown on the settings page.
  ('admin.goodwill_cap_minutes', '100'),
  ('admin.session_idle_minutes', '60'),
  ('admin.session_max_hours', '12'),
  ('admin.code_recency_minutes', '15'),
  ('admin.delete_hold_days', '30'),
  ('refund.window_days', '7'),
  ('refund.first_payment_max_usage_percent', '20');

-- ---------------------------------------------------------------------------
-- The activity log is append only, enforced by the database rather than by
-- the API's good manners: a trigger refuses UPDATE, DELETE and TRUNCATE for
-- every role, and no role is granted those privileges either.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION activity_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_log is append only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER activity_log_no_update BEFORE UPDATE OR DELETE ON "activity_log"
  FOR EACH ROW EXECUTE FUNCTION activity_log_is_append_only();
CREATE TRIGGER activity_log_no_truncate BEFORE TRUNCATE ON "activity_log"
  FOR EACH STATEMENT EXECUTE FUNCTION activity_log_is_append_only();

-- Workspace events reach the log from the portal's own audit trail, so no
-- portal code has to learn about the admin panel. Authorization denials stay
-- in audit_logs: they are violations, not activity. A failure here must never
-- fail the portal write that caused it, so it is reported and swallowed.
CREATE OR REPLACE FUNCTION activity_from_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a_type "ActorType";
  a_name text;
  t_name text;
BEGIN
  IF NEW.action LIKE 'authz.denied.%' THEN
    RETURN NULL;
  END IF;

  IF NEW.actor = 'system' THEN
    a_type := 'system';
  ELSIF NEW.actor = 'platform_admin' THEN
    a_type := 'admin';
  ELSE
    a_type := 'workspace';
    SELECT COALESCE(u.name, u.email) INTO a_name FROM users u WHERE u.id = NEW.actor;
  END IF;

  SELECT t.name INTO t_name FROM tenants t WHERE t.id = NEW.tenant_id;

  INSERT INTO activity_log (at, actor_type, actor_id, actor_name, action, summary,
                            target_workspace_id, target_workspace_name, reason, before, after)
  VALUES (NEW.created_at, a_type, NEW.actor, a_name, NEW.action,
          COALESCE(a_name, initcap(a_type::text)) || ' · ' ||
            replace(replace(NEW.action, '_', ' '), '.', ' '),
          NEW.tenant_id, t_name, NEW.reason, NEW.before, NEW.after);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'activity_from_audit failed: %', SQLERRM;
  RETURN NULL;
END $$;

CREATE TRIGGER audit_logs_to_activity AFTER INSERT ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION activity_from_audit();

-- History so far, so the log does not start empty.
INSERT INTO activity_log (at, actor_type, actor_id, actor_name, action, summary,
                          target_workspace_id, target_workspace_name, reason, before, after)
SELECT a.created_at,
       CASE WHEN a.actor = 'system' THEN 'system'::"ActorType"
            WHEN a.actor = 'platform_admin' THEN 'admin'::"ActorType"
            ELSE 'workspace'::"ActorType" END,
       a.actor,
       COALESCE(u.name, u.email),
       a.action,
       COALESCE(u.name, u.email, initcap(CASE WHEN a.actor = 'system' THEN 'system' ELSE 'workspace' END))
         || ' · ' || replace(replace(a.action, '_', ' '), '.', ' '),
       a.tenant_id, t.name, a.reason, a.before, a.after
FROM audit_logs a
LEFT JOIN users u ON u.id = a.actor
LEFT JOIN tenants t ON t.id = a.tenant_id
WHERE a.action NOT LIKE 'authz.denied.%'
ORDER BY a.created_at;

-- ---------------------------------------------------------------------------
-- Daily usage rollups.
--
-- Maintained by triggers on the meter and on the call record, so they move in
-- the same transaction as the meter and can never drift from it, and survive
-- the deletion of the candidates whose events produced them. Days are
-- Asia/Kolkata days.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ist_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

CREATE OR REPLACE FUNCTION usage_daily_from_meter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d_minutes int;
  d_screenings int;
  d_interviews int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    d_minutes := NEW.interview_minutes_used + NEW.overage_minutes;
    d_screenings := NEW.screenings_used + NEW.overage_screenings;
    d_interviews := NEW.interviews_used;
  ELSE
    d_minutes := (NEW.interview_minutes_used + NEW.overage_minutes)
               - (OLD.interview_minutes_used + OLD.overage_minutes);
    d_screenings := (NEW.screenings_used + NEW.overage_screenings)
                  - (OLD.screenings_used + OLD.overage_screenings);
    d_interviews := NEW.interviews_used - OLD.interviews_used;
  END IF;

  IF d_minutes = 0 AND d_screenings = 0 AND d_interviews = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO usage_daily (tenant_id, day, minutes, screenings, interviews)
  VALUES (NEW.tenant_id, ist_today(), d_minutes, d_screenings, d_interviews)
  ON CONFLICT (tenant_id, day) DO UPDATE SET
    minutes = usage_daily.minutes + EXCLUDED.minutes,
    screenings = usage_daily.screenings + EXCLUDED.screenings,
    interviews = usage_daily.interviews + EXCLUDED.interviews;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'usage_daily_from_meter failed: %', SQLERRM;
  RETURN NULL;
END $$;

CREATE TRIGGER usage_meters_rollup AFTER INSERT OR UPDATE ON "usage_meters"
  FOR EACH ROW EXECUTE FUNCTION usage_daily_from_meter();

-- A call counts once, when it ends (ended_at goes from null to set), under the
-- status it ended with.
CREATE OR REPLACE FUNCTION usage_daily_from_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t text;
BEGIN
  IF NEW.ended_at IS NULL OR NEW.status IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.ended_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.tenant_id INTO t FROM candidates c WHERE c.id = NEW.candidate_id;
  IF t IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO usage_daily (tenant_id, day, calls_completed, calls_no_show, calls_dropped,
                           calls_out_of_window, calls_declined_consent, calls_unknown_caller)
  VALUES (t, ist_today(),
          (NEW.status = 'completed')::int, (NEW.status = 'no_show')::int,
          (NEW.status = 'dropped')::int, (NEW.status = 'out_of_window')::int,
          (NEW.status = 'declined_consent')::int, (NEW.status = 'unknown_caller')::int)
  ON CONFLICT (tenant_id, day) DO UPDATE SET
    calls_completed = usage_daily.calls_completed + EXCLUDED.calls_completed,
    calls_no_show = usage_daily.calls_no_show + EXCLUDED.calls_no_show,
    calls_dropped = usage_daily.calls_dropped + EXCLUDED.calls_dropped,
    calls_out_of_window = usage_daily.calls_out_of_window + EXCLUDED.calls_out_of_window,
    calls_declined_consent = usage_daily.calls_declined_consent + EXCLUDED.calls_declined_consent,
    calls_unknown_caller = usage_daily.calls_unknown_caller + EXCLUDED.calls_unknown_caller;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'usage_daily_from_call failed: %', SQLERRM;
  RETURN NULL;
END $$;

CREATE TRIGGER interview_calls_rollup AFTER INSERT OR UPDATE OF ended_at ON "interview_calls"
  FOR EACH ROW EXECUTE FUNCTION usage_daily_from_call();

-- Backfill.
--
-- Months before this one are rebuilt from the events still on record, which
-- is approximate: screenings removed when a candidate moved job, and anything
-- of a deleted candidate, are gone. This month is taken from the meter itself,
-- carried onto its first day, so that every "this month" figure the panel
-- shows equals what each workspace's own meter says.
WITH ev AS (
  SELECT c.tenant_id,
         ((s.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS day,
         0 AS minutes, 1 AS screenings, 0 AS interviews
  FROM screenings s JOIN candidates c ON c.id = s.candidate_id
  WHERE NOT s.failed
  UNION ALL
  SELECT c.tenant_id,
         ((COALESCE(ic.ended_at, ic.started_at) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date,
         COALESCE(ic.billable_minutes, 0), 0, 1
  FROM interview_calls ic
  JOIN candidates c ON c.id = ic.candidate_id
  JOIN assessment_reports ar ON ar.interview_call_id = ic.id
  WHERE ic.status = 'completed'
)
INSERT INTO usage_daily (tenant_id, day, minutes, screenings, interviews)
SELECT tenant_id, day, sum(minutes), sum(screenings), sum(interviews)
FROM ev
WHERE day < date_trunc('month', ist_today())::date
GROUP BY tenant_id, day;

INSERT INTO usage_daily (tenant_id, day, minutes, screenings, interviews)
SELECT um.tenant_id,
       date_trunc('month', ist_today())::date,
       um.interview_minutes_used + um.overage_minutes,
       um.screenings_used + um.overage_screenings,
       um.interviews_used
FROM usage_meters um
WHERE um.period = to_char(ist_today(), 'YYYY-MM')
ON CONFLICT (tenant_id, day) DO UPDATE SET
  minutes = EXCLUDED.minutes, screenings = EXCLUDED.screenings, interviews = EXCLUDED.interviews;

-- Call outcomes have no meter, so every month comes from the call records.
INSERT INTO usage_daily (tenant_id, day, calls_completed, calls_no_show, calls_dropped,
                         calls_out_of_window, calls_declined_consent, calls_unknown_caller)
SELECT c.tenant_id,
       ((COALESCE(ic.ended_at, ic.started_at) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date,
       count(*) FILTER (WHERE ic.status = 'completed'),
       count(*) FILTER (WHERE ic.status = 'no_show'),
       count(*) FILTER (WHERE ic.status = 'dropped'),
       count(*) FILTER (WHERE ic.status = 'out_of_window'),
       count(*) FILTER (WHERE ic.status = 'declined_consent'),
       count(*) FILTER (WHERE ic.status = 'unknown_caller')
FROM interview_calls ic JOIN candidates c ON c.id = ic.candidate_id
WHERE ic.ended_at IS NOT NULL AND ic.status IS NOT NULL
GROUP BY 1, 2
ON CONFLICT (tenant_id, day) DO UPDATE SET
  calls_completed = EXCLUDED.calls_completed,
  calls_no_show = EXCLUDED.calls_no_show,
  calls_dropped = EXCLUDED.calls_dropped,
  calls_out_of_window = EXCLUDED.calls_out_of_window,
  calls_declined_consent = EXCLUDED.calls_declined_consent,
  calls_unknown_caller = EXCLUDED.calls_unknown_caller;

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- The portal role loses every admin table outright: Non-negotiable 1 holds at
-- the database, not only in the app. It keeps read access to published
-- pricing and settings, and nothing more on them.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    REVOKE ALL ON "admin_users", "admin_sessions", "payments", "activity_log",
                  "usage_daily", "unknown_calls", "blocked_numbers"
      FROM pratibha_app;
    REVOKE ALL ON "plans", "topup_packs", "trial_config", "platform_settings" FROM pratibha_app;
    GRANT SELECT ON "plans", "topup_packs", "trial_config", "platform_settings" TO pratibha_app;
  END IF;
END $$;

-- The admin app's own role: reads across workspaces (BYPASSRLS), never a
-- superuser, and cannot change or remove a log row. Creating a BYPASSRLS role
-- needs a superuser; where the migration runs without one, this is skipped
-- with a notice and the role can be created by hand (see apps/admin/README.md).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_admin') THEN
    CREATE ROLE pratibha_admin NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
  GRANT USAGE ON SCHEMA public TO pratibha_admin;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pratibha_admin;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pratibha_admin;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pratibha_admin;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pratibha_admin;
  REVOKE UPDATE, DELETE, TRUNCATE ON "activity_log" FROM pratibha_admin;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pratibha_admin role not created: %', SQLERRM;
END $$;

REVOKE UPDATE, DELETE, TRUNCATE ON "activity_log" FROM PUBLIC;
