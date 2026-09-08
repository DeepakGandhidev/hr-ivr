-- IMAP ingestion for mailboxes that are not Gmail/Outlook (cPanel webmail,
-- Zoho, Namecheap and friends). These hosts have no OAuth, so the connection
-- carries its own server coordinates and a sealed password.

ALTER TABLE "email_connections"
  ADD COLUMN "imap_host"      TEXT,
  ADD COLUMN "imap_port"      INTEGER,
  ADD COLUMN "imap_secure"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "imap_username"  TEXT,
  ADD COLUMN "imap_secret"    TEXT,
  ADD COLUMN "folder"         TEXT NOT NULL DEFAULT 'INBOX',
  ADD COLUMN "uid_validity"   BIGINT,
  ADD COLUMN "last_seen_uid"  BIGINT,
  ADD COLUMN "default_job_id" TEXT;

-- A connection whose destination job is deleted must stop ingesting rather
-- than keep writing candidates at a dangling job id.
ALTER TABLE "email_connections"
  ADD CONSTRAINT "email_connections_default_job_id_fkey"
  FOREIGN KEY ("default_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The poller selects due connections by provider and last poll time.
CREATE INDEX "email_connections_provider_status_last_poll_at_idx"
  ON "email_connections" ("provider", "status", "last_poll_at");
