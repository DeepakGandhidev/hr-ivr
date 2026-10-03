-- CreateEnum
CREATE TYPE "NameSource" AS ENUM ('cv', 'sender', 'subject');

-- CreateEnum
CREATE TYPE "ScreeningMode" AS ENUM ('auto', 'manual');

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_by" TEXT,
ADD COLUMN     "name_source" "NameSource",
ADD COLUMN     "not_application_at" TIMESTAMP(3),
ADD COLUMN     "not_application_by" TEXT,
ADD COLUMN     "screening_queued_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "screenings" ADD COLUMN     "job_id" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "screening_mode" "ScreeningMode" NOT NULL DEFAULT 'manual',
ADD COLUMN     "screening_mode_changed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "candidates_tenant_id_archived_at_not_application_at_created_idx" ON "candidates"("tenant_id", "archived_at", "not_application_at", "created_at");


-- ---------------------------------------------------------------------------
-- Backfills. Nothing invented, nothing deleted.
-- ---------------------------------------------------------------------------

-- Until now a move deleted the old screenings, so every existing screening was
-- run against the job its candidate is on today.
UPDATE "screenings" s SET "job_id" = c.job_id FROM "candidates" c WHERE c.id = s.candidate_id AND s.job_id IS NULL;
CREATE INDEX "screenings_candidate_id_job_id_idx" ON "screenings"("candidate_id", "job_id");

-- Name source, only where it can be read off the record: a name equal to the
-- email subject came from the subject; a name the CV parse returned from a
-- readable attachment came from the CV. Anything else stays unknown.
UPDATE "candidates" SET "name_source" = 'subject'
WHERE name IS NOT NULL AND cv_parsed->>'emailSubject' IS NOT NULL AND btrim(name) = btrim(cv_parsed->>'emailSubject');
UPDATE "candidates" SET "name_source" = 'cv'
WHERE name_source IS NULL AND name IS NOT NULL AND btrim(name) = btrim(cv_parsed->>'name')
  AND (cv_parsed->'extraction'->>'ok')::boolean IS TRUE;

-- Heuristics and paging for the Pipeline live in configuration (Batch 7).
-- The junk hint suggests "Not an application" when every listed signal holds.
INSERT INTO "platform_settings" (key, value) VALUES
  ('pipeline.junk_rule', '["no_phone", "no_job", "subject_name"]'),
  ('pipeline.auto_screen_batch', '10')
ON CONFLICT (key) DO NOTHING;
