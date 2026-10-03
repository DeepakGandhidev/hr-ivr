-- Batch 5, P01/P16: the device and place each sign-in came from, captured once
-- when a real browser signs in. GoTrue's auth.sessions.user_agent is rewritten
-- by every server-side token refresh ("Next.js Middleware"), so it cannot say
-- which device a session belongs to. Read and written through the admin
-- connection only; the RLS-bound app role has no business here.
CREATE TABLE "session_origins" (
  "session_id" UUID NOT NULL,
  "user_id"    TEXT NOT NULL,
  "user_agent" TEXT,
  "ip"         TEXT,
  "city"       TEXT,
  "country"    TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "session_origins_pkey" PRIMARY KEY ("session_id")
);
CREATE INDEX "session_origins_user_id_idx" ON "session_origins"("user_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    REVOKE ALL ON "session_origins" FROM pratibha_app;
  END IF;
END $$;
