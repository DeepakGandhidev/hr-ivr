-- One-time Cashfree checkouts (top-ups, plan upgrades) and the billing phone
-- number Cashfree requires. Admin connection only, like session_origins.
ALTER TABLE "subscriptions" ADD COLUMN "billing_phone" TEXT;

CREATE TABLE "checkout_orders" (
  "id"         TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "order_id"   TEXT NOT NULL,
  "purpose"    TEXT NOT NULL,
  "pack_id"    TEXT,
  "plan_id"    TEXT,
  "status"     TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at"    TIMESTAMP(3),
  CONSTRAINT "checkout_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checkout_orders_invoice_id_key" ON "checkout_orders"("invoice_id");
CREATE UNIQUE INDEX "checkout_orders_order_id_key" ON "checkout_orders"("order_id");
CREATE INDEX "checkout_orders_tenant_id_created_at_idx" ON "checkout_orders"("tenant_id", "created_at");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_app') THEN
    REVOKE ALL ON "checkout_orders" FROM pratibha_app;
  END IF;
END $$;
