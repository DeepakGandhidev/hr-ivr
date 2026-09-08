-- Row-level security: the second wall from §7.
--
-- withTenant() issues `SET LOCAL app.current_tenant = '<id>'` before every
-- request-scoped query, but until now nothing consumed that setting: RLS was
-- never enabled and no policy existed, so `tx.job.findMany()` returned every
-- tenant's rows. The API layer checks that the *user* belongs to the tenant; it
-- does not filter the rows themselves. That is what this restores.
--
-- FORCE ROW LEVEL SECURITY is set so the table owner is subject to its own
-- policies. Superusers still bypass RLS entirely by design, which is why the
-- application connects as a dedicated NOSUPERUSER role (see below) and only the
-- worker — which must read across tenants for caller recognition — keeps an
-- owner/superuser connection.

-- Resolves to NULL rather than erroring when the GUC is unset, so a connection
-- that never called withTenant() simply matches nothing.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text AS $$
  SELECT nullif(current_setting('app.current_tenant', true), '');
$$ LANGUAGE sql STABLE;

-- --------------------------------------------------------------------------
-- Tables carrying tenant_id directly.
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'email_connections', 'jobs', 'candidates',
    'outreach_templates', 'interview_protocols', 'usage_meters', 'audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- The tenant row itself is keyed on id, not tenant_id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- --------------------------------------------------------------------------
-- Tables reached through a job.
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_descriptions', 'job_posts', 'shortlists', 'call_windows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = %I.job_id AND j.tenant_id = current_tenant_id()))
        WITH CHECK (EXISTS (SELECT 1 FROM jobs j WHERE j.id = %I.job_id AND j.tenant_id = current_tenant_id()))
    $f$, t, t, t);
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- Tables reached through a candidate.
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['screenings', 'outreach_emails', 'interview_calls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (EXISTS (SELECT 1 FROM candidates c WHERE c.id = %I.candidate_id AND c.tenant_id = current_tenant_id()))
        WITH CHECK (EXISTS (SELECT 1 FROM candidates c WHERE c.id = %I.candidate_id AND c.tenant_id = current_tenant_id()))
    $f$, t, t, t);
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- Tables reached through a shortlist, and the report reached through a call.
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shortlist_items', 'approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (EXISTS (
          SELECT 1 FROM shortlists s JOIN jobs j ON j.id = s.job_id
          WHERE s.id = %I.shortlist_id AND j.tenant_id = current_tenant_id()))
        WITH CHECK (EXISTS (
          SELECT 1 FROM shortlists s JOIN jobs j ON j.id = s.job_id
          WHERE s.id = %I.shortlist_id AND j.tenant_id = current_tenant_id()))
    $f$, t, t, t);
  END LOOP;
END $$;

ALTER TABLE assessment_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON assessment_reports;
CREATE POLICY tenant_isolation ON assessment_reports
  USING (EXISTS (
    SELECT 1 FROM interview_calls ic JOIN candidates c ON c.id = ic.candidate_id
    WHERE ic.id = assessment_reports.interview_call_id AND c.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM interview_calls ic JOIN candidates c ON c.id = ic.candidate_id
    WHERE ic.id = assessment_reports.interview_call_id AND c.tenant_id = current_tenant_id()));

-- plans, prompt_templates and platform_users are platform-wide reference data
-- (§4) and carry no tenant_id, so they are deliberately left unrestricted.

-- --------------------------------------------------------------------------
-- The application role. A superuser bypasses RLS even with FORCE, so the web
-- app must not connect as one.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    CREATE ROLE pratibha_app LOGIN PASSWORD 'pratibha_app';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO pratibha_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pratibha_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pratibha_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pratibha_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pratibha_app;
