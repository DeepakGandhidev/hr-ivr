-- One mailbox serving every open role, instead of one mailbox per job.
--
-- When auto_route is on, the ingester matches each application against the
-- tenant's open jobs and files it against the best match. default_job_id stays
-- required, but changes meaning: it becomes the fallback bucket for mail that
-- matches nothing, so an unrecognised application is still visible to a
-- recruiter rather than silently dropped.

ALTER TABLE "email_connections"
  ADD COLUMN "auto_route" BOOLEAN NOT NULL DEFAULT false;

-- Which job the router actually chose, and how sure it was. Without this a
-- recruiter cannot tell a confident match from a fallback guess.
ALTER TABLE "candidates"
  ADD COLUMN "routed_by"         TEXT,
  ADD COLUMN "routing_confidence" INTEGER;
