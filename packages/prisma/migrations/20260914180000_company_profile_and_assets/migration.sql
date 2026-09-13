-- CreateEnum
CREATE TYPE "TenantAssetKind" AS ENUM ('company_logo', 'user_photo');

-- CreateTable: the index of files a tenant owns.
--
-- The bytes live behind the storage driver; this table is what makes them
-- findable. Files written to disk with only a path in some column are exactly
-- the ones nobody remembers to delete when a customer asks to be forgotten.
CREATE TABLE "tenant_assets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "TenantAssetKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_assets_tenant_id_kind_idx" ON "tenant_assets"("tenant_id", "kind");

-- CreateTable: the company as an entity, distinct from how it sounds on a call.
CREATE TABLE "company_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_name" TEXT,
    "billing_address" TEXT,
    "billing_state" TEXT,
    "gstin" TEXT,
    "description" TEXT,
    "logo_asset_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "company_profiles_tenant_id_key" ON "company_profiles"("tenant_id");

-- AlterTable: personal profile fields.
ALTER TABLE "users"
  ADD COLUMN "photo_asset_id" TEXT,
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "notification_prefs" JSONB,
  ADD COLUMN "two_factor_secret" TEXT,
  ADD COLUMN "two_factor_enabled_at" TIMESTAMP(3),
  ADD COLUMN "two_factor_recovery" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AddForeignKey
ALTER TABLE "tenant_assets" ADD CONSTRAINT "tenant_assets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: deleting a logo file should clear the reference, not
-- delete the company's whole profile.
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_logo_asset_id_fkey"
  FOREIGN KEY ("logo_asset_id") REFERENCES "tenant_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "users" ADD CONSTRAINT "users_photo_asset_id_fkey"
  FOREIGN KEY ("photo_asset_id") REFERENCES "tenant_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- Row-level security, matching every other tenant-scoped table.
--
-- Without this the new tables are the one place in the schema where a tenant
-- could read another tenant's rows - and one of them holds photographs of named
-- employees.
-- --------------------------------------------------------------------------
ALTER TABLE tenant_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_assets;
CREATE POLICY tenant_isolation ON tenant_assets
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE company_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_profiles;
CREATE POLICY tenant_isolation ON company_profiles
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- --------------------------------------------------------------------------
-- Seed the legal name from the workspace name.
--
-- A reasonable starting point that the customer can correct, and it means an
-- invoice generated before anyone visits this screen carries a real name rather
-- than a blank. Nothing else is guessed - an invented GSTIN or address on an
-- invoice would be worse than an obviously missing one.
-- --------------------------------------------------------------------------
INSERT INTO company_profiles (id, tenant_id, legal_name, created_at, updated_at)
SELECT 'cp_' || t.id, t.id, t.name, NOW(), NOW()
FROM tenants t;
