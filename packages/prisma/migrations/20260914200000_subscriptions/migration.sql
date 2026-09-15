-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelling', 'expired');
CREATE TYPE "MandateStatus" AS ENUM ('none', 'pending', 'active', 'failed', 'revoked');
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'paid', 'void');
CREATE TYPE "CouponKind" AS ENUM ('percent', 'amount', 'minutes');

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "top_up_minutes" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "cancel_comment" TEXT,
    "billing_contact_email" TEXT,
    "billing_contact_prefs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");

CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "mandate_status" "MandateStatus" NOT NULL DEFAULT 'none',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payment_methods_subscription_id_is_default_idx" ON "payment_methods"("subscription_id", "is_default");

-- Money is in paise as integers. Floating point on money produces invoices that
-- are off by a rupee, and a CA who finds one stops trusting all of them.
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'issued',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "lines" JSONB NOT NULL,
    "subtotal_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "cgst_paise" INTEGER NOT NULL DEFAULT 0,
    "sgst_paise" INTEGER NOT NULL DEFAULT 0,
    "igst_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL,
    "place_of_supply" TEXT NOT NULL,
    "seller" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");
CREATE INDEX "invoices_subscription_id_issued_at_idx" ON "invoices"("subscription_id", "issued_at");

-- Coupons are platform-wide, not tenant-scoped: no tenant_id and no RLS policy.
-- Redemptions are what belong to a tenant.
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "CouponKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "max_redemptions" INTEGER,
    "redeemed_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coupon_redemptions_coupon_id_subscription_id_key" ON "coupon_redemptions"("coupon_id", "subscription_id");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- Row-level security.
--
-- `subscriptions` is scoped directly. The three that hang off it are scoped
-- THROUGH it, because they carry no tenant_id of their own - and an invoice is
-- exactly the kind of row that must never be readable across a tenant boundary.
-- --------------------------------------------------------------------------
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON subscriptions;
CREATE POLICY tenant_isolation ON subscriptions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment_methods;
CREATE POLICY tenant_isolation ON payment_methods
  USING (EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = payment_methods.subscription_id AND s.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = payment_methods.subscription_id AND s.tenant_id = current_tenant_id()));

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON invoices;
CREATE POLICY tenant_isolation ON invoices
  USING (EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = invoices.subscription_id AND s.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = invoices.subscription_id AND s.tenant_id = current_tenant_id()));

ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON coupon_redemptions;
CREATE POLICY tenant_isolation ON coupon_redemptions
  USING (EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = coupon_redemptions.subscription_id AND s.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = coupon_redemptions.subscription_id AND s.tenant_id = current_tenant_id()));

-- --------------------------------------------------------------------------
-- Seed a subscription per existing tenant.
--
-- Anchored to the trial end where there is one, otherwise a month from now.
-- The alternative - leaving it null until someone opens the page - would show a
-- "days left" figure of nothing on the one screen that exists to answer that.
-- --------------------------------------------------------------------------
INSERT INTO subscriptions (id, tenant_id, plan_id, status, period_start, period_end, created_at, updated_at)
SELECT
  'sub_' || t.id,
  t.id,
  t.plan_id,
  CASE WHEN t.status = 'trial' THEN 'trialing'::"SubscriptionStatus" ELSE 'active'::"SubscriptionStatus" END,
  NOW(),
  COALESCE(t.trial_ends_at, NOW() + INTERVAL '1 month'),
  NOW(),
  NOW()
FROM tenants t;
