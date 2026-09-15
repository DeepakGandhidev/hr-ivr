-- AlterTable: metering moves from interviews to minutes.
--
-- `interviews_used` stays. It is no longer the quota, but historical periods
-- should keep reading correctly, and the UI shows an approximate interview
-- count beside the minutes because customers reason in interviews and are
-- billed in minutes.
ALTER TABLE "usage_meters"
  ADD COLUMN "interview_minutes_used" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "overage_minutes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: what each call was billed, and the moment billing started.
--
-- Stored rather than derived so an invoice line can be reconciled against the
-- call that produced it, even if the rounding rule changes later.
ALTER TABLE "interview_calls"
  ADD COLUMN "first_question_at" TIMESTAMP(3),
  ADD COLUMN "billable_minutes" INTEGER;

-- --------------------------------------------------------------------------
-- Backfill: what past calls would have cost under per-minute pricing.
--
-- `first_question_at` was never recorded, so the honest starting point is the
-- whole call duration for calls that actually reached an interview. That
-- OVERSTATES them - it includes the greeting and consent that per-minute
-- pricing deliberately excludes - so it is written to `billable_minutes` for
-- reference only and is NOT added to any usage meter. Nobody is retro-billed
-- for calls made under per-interview pricing.
--
-- Only completed calls with a report: the same bar live billing uses.
-- --------------------------------------------------------------------------
UPDATE interview_calls ic
SET billable_minutes = GREATEST(1, CEIL(EXTRACT(EPOCH FROM (ic.ended_at - ic.started_at)) / 60.0))
FROM assessment_reports ar
WHERE ar.interview_call_id = ic.id
  AND ic.ended_at IS NOT NULL
  AND ic.status = 'completed'
  AND ic.billable_minutes IS NULL;
