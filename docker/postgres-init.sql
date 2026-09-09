-- Everything Postgres needs before either service starts.
--
-- Two separate concerns, both of which fail confusingly if missed:
--
-- 1. The app connects as a NOSUPERUSER role so row-level security actually
--    binds. A superuser bypasses RLS even with FORCE ROW LEVEL SECURITY, so
--    running the app as the owner silently disables tenant isolation - the
--    app works, and every tenant sees every other tenant's data.
-- 2. GoTrue owns its own schema and runs its own migrations, but it cannot
--    create the role or schema it needs.

-- The restricted role the web app uses.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    CREATE ROLE pratibha_app LOGIN PASSWORD 'pratibha_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT CONNECT ON DATABASE pratibha TO pratibha_app;
GRANT USAGE ON SCHEMA public TO pratibha_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pratibha_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pratibha_app;

-- GoTrue's own migrations grant SELECT on its tables to a role named
-- `postgres`, which Supabase's images always have but the stock postgres image
-- does not when POSTGRES_USER is something else. Without it auth dies on
-- startup with `role "postgres" does not exist`, and the only visible symptom
-- is that nobody can log in.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    -- Local development only. Nothing connects as this role; it exists so the
    -- grants in GoTrue's migrations have a target.
    CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres';
  END IF;
END $$;

-- Auth, for GoTrue.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN PASSWORD 'supabase_auth_admin' NOSUPERUSER CREATEDB;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
