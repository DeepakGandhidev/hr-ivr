-- Gmail / Outlook sign-in and forwarding addresses for email_connections.
-- Additive only: the previous code ignores these columns.
ALTER TABLE "email_connections"
  ADD COLUMN "oauth_refresh_secret" TEXT,
  ADD COLUMN "oauth_access_secret" TEXT,
  ADD COLUMN "oauth_expires_at" TIMESTAMP(3),
  ADD COLUMN "forward_token" TEXT,
  ADD COLUMN "forward_verify_code" TEXT,
  ADD COLUMN "forward_verify_url" TEXT,
  ADD COLUMN "forward_verify_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "email_connections_forward_token_key" ON "email_connections"("forward_token");
