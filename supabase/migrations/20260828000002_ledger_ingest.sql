-- Migration: 20260828000002_ledger_ingest.sql
-- Description: Schema support for Horizon ledger ingest worker and transaction operation indexing.

BEGIN;

-- 1. Ingest worker state table for cursor persistence and lag tracking
CREATE TABLE IF NOT EXISTS ingest_state (
    key TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    last_ledger INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Add operation index to transactions for multi-operation transaction idempotency
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS op_index INTEGER NOT NULL DEFAULT 0;

-- 3. Create unique index for idempotent upserts on (tx_hash, op_index)
DROP INDEX IF EXISTS idx_transactions_tx_hash_op_index;
CREATE UNIQUE INDEX idx_transactions_tx_hash_op_index ON transactions(tx_hash, op_index);

-- 4. Index for pending transaction timeout reconciliation
CREATE INDEX IF NOT EXISTS idx_transactions_pending_timeout ON transactions(status, submitted_at)
WHERE status = 'pending';

-- 5. RLS policies on ingest_state (service role only)
ALTER TABLE ingest_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ingest_state_service_all" ON ingest_state;
CREATE POLICY "ingest_state_service_all" ON ingest_state
FOR ALL
USING (auth.jwt() ->> 'role' = 'service_role')
WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

REVOKE ALL ON ingest_state FROM anon, authenticated;

COMMIT;

