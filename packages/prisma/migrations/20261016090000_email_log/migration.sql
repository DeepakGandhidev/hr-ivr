-- A log of every email Pratibha sends from its own mailbox. Additive.
CREATE TABLE "email_log" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tenant_id" TEXT,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "error" TEXT,
    "response" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    CONSTRAINT "email_log_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_log_dedupe_key_key" ON "email_log"("dedupe_key");
CREATE INDEX "email_log_created_at_idx" ON "email_log"("created_at");
CREATE INDEX "email_log_kind_created_at_idx" ON "email_log"("kind", "created_at");

-- The portal writes its own sends; the admin panel reads them all.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "email_log" TO pratibha_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_admin') THEN
    GRANT SELECT, INSERT, UPDATE ON "email_log" TO pratibha_admin;
  END IF;
END $$;
