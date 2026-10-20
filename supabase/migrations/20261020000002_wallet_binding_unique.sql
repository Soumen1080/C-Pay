-- Keep one deterministic active owner when historical client-write access
-- created conflicting bindings, then enforce global active ownership.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY wallet_address
    ORDER BY created_at ASC, auth_user_id ASC, id ASC
  ) AS owner_rank
  FROM wallet_bindings
  WHERE is_active
)
UPDATE wallet_bindings AS binding
SET is_active = FALSE
FROM ranked
WHERE binding.id = ranked.id AND ranked.owner_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_bindings_one_active_owner
  ON wallet_bindings(wallet_address)
  WHERE is_active;
