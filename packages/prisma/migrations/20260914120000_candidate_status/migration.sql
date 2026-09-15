-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM (
  'inbox',
  'screened',
  'shortlisted',
  'interviewed',
  'advance_stage',
  'hired',
  'rejected'
);

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN "status" "CandidateStatus" NOT NULL DEFAULT 'inbox';

-- CreateIndex
CREATE INDEX "candidates_tenant_id_job_id_status_idx" ON "candidates"("tenant_id", "job_id", "status");

-- --------------------------------------------------------------------------
-- Backfill: derive where each existing candidate already stands.
--
-- Defaulting everyone to 'inbox' would be wrong on the first screen a recruiter
-- opens - candidates who have been screened, shortlisted and interviewed would
-- all read as untouched, and the field would look broken rather than new. The
-- events that drive the four automatic statuses are all still on record, so the
-- starting position is derived from them rather than guessed.
--
-- Applied weakest-first so the strongest evidence wins: a candidate with both a
-- screening and a report ends on 'interviewed'. The three manual statuses are
-- judgements and are deliberately not inferred - nothing here decides that
-- somebody was hired or rejected.
-- --------------------------------------------------------------------------
UPDATE candidates c
SET status = 'screened'
WHERE EXISTS (SELECT 1 FROM screenings s WHERE s.candidate_id = c.id);

UPDATE candidates c
SET status = 'shortlisted'
WHERE EXISTS (SELECT 1 FROM shortlist_items si WHERE si.candidate_id = c.id);

UPDATE candidates c
SET status = 'interviewed'
WHERE EXISTS (
  SELECT 1
  FROM interview_calls ic
  JOIN assessment_reports ar ON ar.interview_call_id = ic.id
  WHERE ic.candidate_id = c.id
);
