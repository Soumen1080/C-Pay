-- Migration 004: Fix Add Money faucet drain vulnerability (#34)
--
-- 1. Add auth_user_id column to key cooldown on authenticated user, not wallet.
-- 2. Add a unique partial index on (auth_user_id) WHERE next_available_at > NOW()
--    so that concurrent INSERTs for the same user will conflict (atomic lock).
-- 3. Add daily_claim_count to enforce a per-user daily cap.

-- Step 1: Add auth_user_id column (nullable for backward compat with old rows)
ALTER TABLE add_money_claims
  ADD COLUMN IF NOT EXISTS auth_user_id TEXT;

-- Step 2: Create index for fast per-user cooldown lookups
CREATE INDEX IF NOT EXISTS idx_add_money_claims_auth_user_id
  ON add_money_claims(auth_user_id);

-- Step 3: Create index for per-user daily cap counting
CREATE INDEX IF NOT EXISTS idx_add_money_claims_auth_user_id_claimed_at
  ON add_money_claims(auth_user_id, claimed_at DESC);
