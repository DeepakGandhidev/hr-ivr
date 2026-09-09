-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_by" TEXT;

-- CreateTable
CREATE TABLE "job_versions" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "salary_band" TEXT,
    "experience_range" TEXT,
    "must_haves" JSONB NOT NULL,
    "good_to_haves" JSONB NOT NULL,
    "screening_threshold" INTEGER,
    "change_note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_notes" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_versions_job_id_version_key" ON "job_versions"("job_id", "version");

-- CreateIndex
CREATE INDEX "candidate_notes_candidate_id_created_at_idx" ON "candidate_notes"("candidate_id", "created_at");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_versions" ADD CONSTRAINT "job_versions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_versions" ADD CONSTRAINT "job_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- Row-level security for the two new tables.
--
-- Without this they are readable across tenants: RLS is per-table, so a table
-- added after 20260903111500_enable_rls inherits nothing from it. job_versions
-- carries a role's salary band and hiring criteria, and candidate_notes carries
-- a colleague's written opinion of a named person - neither may cross a tenant
-- boundary. Same shape as the existing policies: reached through a job, and
-- reached through a candidate, respectively.
-- --------------------------------------------------------------------------
ALTER TABLE job_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_versions;
CREATE POLICY tenant_isolation ON job_versions
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_versions.job_id AND j.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_versions.job_id AND j.tenant_id = current_tenant_id()));

ALTER TABLE candidate_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON candidate_notes;
CREATE POLICY tenant_isolation ON candidate_notes
  USING (EXISTS (SELECT 1 FROM candidates c WHERE c.id = candidate_notes.candidate_id AND c.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM candidates c WHERE c.id = candidate_notes.candidate_id AND c.tenant_id = current_tenant_id()));

-- The application role is granted per-table, so the new tables need it too or
-- the web app gets "permission denied" on its first read.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON job_versions, candidate_notes TO pratibha_app;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Backfill: every existing job becomes version 1 of itself.
--
-- Without this, history starts empty and the first edit silently discards what
-- the role looked like when its candidates were screened against it - which is
-- the exact question version history exists to answer.
-- --------------------------------------------------------------------------
INSERT INTO job_versions (
  id, job_id, version, title, location, salary_band, experience_range,
  must_haves, good_to_haves, screening_threshold, change_note, created_by, created_at
)
SELECT
  'jv_' || j.id, j.id, 1, j.title, j.location, j.salary_band, j.experience_range,
  j.must_haves, j.good_to_haves, j.screening_threshold,
  'Original version, recorded when version history was introduced.',
  j.created_by, j.created_at
FROM jobs j;
