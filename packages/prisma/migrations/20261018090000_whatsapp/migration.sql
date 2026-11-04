-- WhatsApp notifications through Meta's Cloud API. Additive only: the previous
-- code ignores the new tables and columns.

-- Every WhatsApp message Pratibha sends, like email_log. The webhook finds a
-- row by Meta's message id (wamid) to record delivered, read or failed.
CREATE TABLE "whatsapp_log" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tenant_id" TEXT,
    "to_phone" TEXT NOT NULL,
    "template" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "error" TEXT,
    "wamid" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_log_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "whatsapp_log_wamid_key" ON "whatsapp_log"("wamid");
CREATE UNIQUE INDEX "whatsapp_log_dedupe_key_key" ON "whatsapp_log"("dedupe_key");
CREATE INDEX "whatsapp_log_created_at_idx" ON "whatsapp_log"("created_at");
CREATE INDEX "whatsapp_log_kind_created_at_idx" ON "whatsapp_log"("kind", "created_at");

-- Numbers that replied STOP. Platform-wide: there is one sending number.
CREATE TABLE "whatsapp_optouts" (
    "phone_e164" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    CONSTRAINT "whatsapp_optouts_pkey" PRIMARY KEY ("phone_e164")
);

-- Team members: a mobile number for alerts and an explicit opt-in.
ALTER TABLE "users"
  ADD COLUMN "phone_e164" TEXT,
  ADD COLUMN "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT false;

-- Candidates: opted in to updates on WhatsApp, and when.
ALTER TABLE "candidates"
  ADD COLUMN "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "whatsapp_opt_in_at" TIMESTAMP(3);

-- The portal sends and receives the webhook (START deletes an opt-out); the
-- admin panel reads the log and sends its test.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "whatsapp_log" TO pratibha_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_optouts" TO pratibha_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_admin') THEN
    GRANT SELECT, INSERT, UPDATE ON "whatsapp_log" TO pratibha_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_optouts" TO pratibha_admin;
  END IF;
END $$;
