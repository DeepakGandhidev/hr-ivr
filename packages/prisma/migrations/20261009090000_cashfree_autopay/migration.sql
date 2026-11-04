-- Cashfree AutoPay: the renewal invoice whose charge is in flight, so the
-- renewal job cannot invoice the same period twice.
ALTER TABLE "subscriptions" ADD COLUMN "renewal_invoice_id" TEXT;
CREATE UNIQUE INDEX "subscriptions_renewal_invoice_id_key" ON "subscriptions"("renewal_invoice_id");
