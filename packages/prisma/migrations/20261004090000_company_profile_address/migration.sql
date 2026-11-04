-- Batch 8, CP20: the registered address becomes address line, city, PIN code
-- and state (state already exists as billing_state).
ALTER TABLE "company_profiles"
  ADD COLUMN "address_line" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "pin_code" TEXT;

-- Best effort, never invented. The only part lifted out of the old free-text
-- address is a PIN code that is unambiguously there: one six digit number
-- (not starting 0) at the very end. Everything else is parked in the address
-- line, and the city is left blank for the customer to fill in.
UPDATE "company_profiles"
SET
  "pin_code" = CASE
    WHEN billing_address ~ '(^|[^0-9])[1-9][0-9]{5}[[:space:].,]*$'
     AND (SELECT count(*) FROM regexp_matches(billing_address, '(^|[^0-9])[1-9][0-9]{5}([^0-9]|$)', 'g')) = 1
    THEN substring(billing_address from '([1-9][0-9]{5})[[:space:].,]*$')
    ELSE NULL END,
  "address_line" = CASE
    WHEN billing_address ~ '(^|[^0-9])[1-9][0-9]{5}[[:space:].,]*$'
     AND (SELECT count(*) FROM regexp_matches(billing_address, '(^|[^0-9])[1-9][0-9]{5}([^0-9]|$)', 'g')) = 1
    THEN nullif(btrim(regexp_replace(regexp_replace(billing_address, '[[:space:],.-]*[1-9][0-9]{5}[[:space:].,]*$', ''), '[[:space:]]*\n[[:space:]]*', ', ', 'g'), ' ,'), '')
    ELSE nullif(btrim(regexp_replace(billing_address, '[[:space:]]*\n[[:space:]]*', ', ', 'g'), ' ,'), '')
    END
WHERE billing_address IS NOT NULL AND btrim(billing_address) <> '';

-- Field limits for this page live in configuration, not code.
INSERT INTO "platform_settings" (key, value) VALUES
  ('company.legal_name_max', '200'),
  ('company.address_line_max', '300'),
  ('company.city_max', '100'),
  ('company.logo_max_bytes', '2097152')
ON CONFLICT (key) DO NOTHING;

-- CP12: the description cap defaults to 600. Only moved if nobody has set it.
UPDATE "platform_settings" SET value = '600'
WHERE key = 'company.description_cap' AND value = '5000' AND updated_by IS NULL;
