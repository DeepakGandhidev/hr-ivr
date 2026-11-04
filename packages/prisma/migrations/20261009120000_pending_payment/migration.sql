-- Paid signup: a workspace stays here until its first month is paid through
-- Cashfree, and only the activation screen opens meanwhile.
ALTER TYPE "TenantStatus" ADD VALUE IF NOT EXISTS 'pending_payment';
