-- Website content edited in the admin panel. Additive only: nothing else reads
-- these tables, so the previous code runs against this schema unchanged.

CREATE TABLE "site_entries" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB,
    "live" JSONB,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    CONSTRAINT "site_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_entries_kind_key_key" ON "site_entries"("kind", "key");

CREATE TABLE "site_publishes" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "changes" INTEGER NOT NULL DEFAULT 0,
    "log" TEXT,
    "started_by" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "site_publishes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "site_publishes_started_at_idx" ON "site_publishes"("started_at");

-- Only the admin panel reads or writes these; the portal has no use for them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "site_entries", "site_publishes" TO pratibha_admin;
  END IF;
END $$;
