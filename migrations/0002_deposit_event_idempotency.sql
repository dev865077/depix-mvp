-- Remove duplicatas exatas antes de reforcar a idempotencia no banco.
-- Mantemos o primeiro registro para preservar a trilha historica mais antiga.

DELETE FROM deposit_events
WHERE id NOT IN (
  SELECT MIN(id)
  FROM deposit_events
  GROUP BY
    tenant_id,
    deposit_id,
    source,
    external_status,
    IFNULL(bank_tx_id, ''),
    IFNULL(blockchain_tx_id, ''),
    raw_payload
);

CREATE UNIQUE INDEX IF NOT EXISTS deposit_events_idempotency_unique_idx
ON deposit_events (
  tenant_id,
  deposit_id,
  source,
  external_status,
  IFNULL(bank_tx_id, ''),
  IFNULL(blockchain_tx_id, ''),
  raw_payload
);
