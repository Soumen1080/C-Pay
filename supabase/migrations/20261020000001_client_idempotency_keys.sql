-- Client supplied idempotency keys are private to an authenticated user and
-- bound to the exact request payload. Internal relayer locks remain in the
-- legacy relayer_idempotency_keys table.
CREATE TABLE IF NOT EXISTS relayer_client_idempotency_keys (
  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (auth_user_id, key)
);

ALTER TABLE relayer_client_idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON relayer_client_idempotency_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON relayer_client_idempotency_keys TO service_role;
CREATE INDEX IF NOT EXISTS idx_relayer_client_idempotency_expires_at
  ON relayer_client_idempotency_keys(expires_at);
