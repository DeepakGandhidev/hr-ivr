-- Each app's report of the settings it is running with (portal, worker).
-- Additive; nothing reads it except the admin panel's Platform settings page.
CREATE TABLE "app_runtime_reports" (
    "app" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_runtime_reports_pkey" PRIMARY KEY ("app")
);

-- The portal may write its own report, and nothing about the settings
-- themselves: platform_settings stays SELECT-only for pratibha_app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "app_runtime_reports" TO pratibha_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_admin') THEN
    GRANT SELECT ON "app_runtime_reports" TO pratibha_admin;
  END IF;
END $$;
