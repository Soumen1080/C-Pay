-- Migration: 20260828000001_drop_merchant_schema.sql
-- Description: Drop merchant tables, functions, triggers, and columns while preserving pilot transaction data.
-- Rollout Order:
--   1. Ship App updates (#8–#11) so mobile clients no longer call merchant RPCs or read merchant columns.
--   2. Ship Relayer update (#12) so backend services no longer reference merchant schema.
--   3. Apply this database migration.

BEGIN;

-- 1. Preserve pilot transaction data before dropping columns
-- If transactions had merchant_name or merchant_id, ensure details are preserved in note / recipient_name.
UPDATE transactions
SET
  recipient_name = COALESCE(recipient_name, merchant_name),
  note = CASE
    WHEN (note IS NULL OR note = '') AND merchant_name IS NOT NULL AND merchant_name != ''
      THEN 'Merchant payment: ' || merchant_name
    WHEN note IS NOT NULL AND note != '' AND merchant_name IS NOT NULL AND merchant_name != '' AND note NOT LIKE '%' || merchant_name || '%'
      THEN note || ' (Merchant: ' || merchant_name || ')'
    ELSE note
  END
WHERE merchant_name IS NOT NULL AND merchant_name != '';

-- Convert existing 'merchant' transactions to 'personal' so they satisfy the updated CHECK constraint
UPDATE transactions
SET transaction_type = 'personal'
WHERE transaction_type = 'merchant';

-- 2. Update transaction_type CHECK constraint on transactions table
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'transactions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%transaction_type%'
    ) LOOP
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;
END $$;

ALTER TABLE transactions
ADD CONSTRAINT transactions_transaction_type_check
CHECK (transaction_type IN ('personal', 'add_money', 'account_setup'));

-- 3. Update transactions RLS policy (remove reference to merchants / merchant_id)
DROP POLICY IF EXISTS "transactions_select_participant" ON transactions;
CREATE POLICY "transactions_select_participant" ON transactions
FOR SELECT
USING (
  auth.uid() IS NOT NULL AND (
    from_address = current_wallet_address()
    OR to_address = current_wallet_address()
  )
);

-- 4. Drop triggers backing update_merchant_totals_from_transaction and merchant updated_at
DROP TRIGGER IF EXISTS update_merchant_totals_on_transactions ON transactions;
DROP TRIGGER IF EXISTS update_merchants_updated_at ON merchants;
DROP TRIGGER IF EXISTS update_merchant_qr_codes_updated_at ON merchant_qr_codes;
DROP TRIGGER IF EXISTS update_merchant_contact_verifications_updated_at ON merchant_contact_verifications;

-- 5. Drop merchant-related functions
DROP FUNCTION IF EXISTS get_public_merchant_by_id(UUID);
DROP FUNCTION IF EXISTS get_public_merchant_by_address(TEXT);
DROP FUNCTION IF EXISTS get_own_merchant_by_wallet(TEXT);
DROP FUNCTION IF EXISTS refresh_merchant_totals(UUID);
DROP FUNCTION IF EXISTS update_merchant_totals_from_transaction();

-- 6. Update resolve_cpay_id function to remove dependency on merchants table
CREATE OR REPLACE FUNCTION resolve_cpay_id(p_cpay_id TEXT)
RETURNS TABLE (
  wallet_address TEXT,
  cpay_id TEXT,
  display_name TEXT,
  account_type TEXT
) AS $$
  SELECT u.wallet_address, u.cpay_id, u.display_name, 'user'::TEXT
  FROM users u
  WHERE lower(u.cpay_id) = lower(p_cpay_id)
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 7. Drop columns on transactions
ALTER TABLE transactions DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE transactions DROP COLUMN IF EXISTS merchant_name;

-- 8. Drop merchant tables (and dependent tables like contact verifications)
DROP TABLE IF EXISTS merchant_contact_verifications CASCADE;
DROP TABLE IF EXISTS merchant_qr_codes CASCADE;
DROP TABLE IF EXISTS merchants CASCADE;

-- 9. Drop leftover indexes if any
DROP INDEX IF EXISTS idx_transactions_merchant_id;
DROP INDEX IF EXISTS idx_merchants_wallet_address;
DROP INDEX IF EXISTS idx_merchants_auth_user_id;
DROP INDEX IF EXISTS idx_merchants_cpay_id;
DROP INDEX IF EXISTS idx_merchant_contact_verifications_auth_user;
DROP INDEX IF EXISTS idx_merchant_contact_verifications_merchant;
DROP INDEX IF EXISTS idx_merchant_qr_codes_merchant_id;

COMMIT;
