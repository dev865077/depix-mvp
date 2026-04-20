-- Reforca a invariavel financeira do MVP: um pedido local pode ter no maximo
-- um deposito Pix/DePix associado.
--
-- Rollout seguro:
-- 1. preserva duplicados historicos em tabelas de quarentena auditaveis;
-- 2. remove do agregado ativo somente as linhas nao canonicas;
-- 3. cria o indice unico sobre a tabela ativa ja saneada.
--
-- A linha canonica e escolhida por prioridade operacional: status conclusivo
-- (`depix_sent`) vence status pendente; em empate, fica o registro mais recente.
-- Assim a migration nao falha em production por sujeira historica e tambem nao
-- apaga evidencia dos duplicados que precisam de revisao operacional.

CREATE TABLE IF NOT EXISTS deposit_order_duplicate_quarantine (
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  deposit_entry_id TEXT PRIMARY KEY NOT NULL,
  qr_id TEXT,
  nonce TEXT NOT NULL,
  qr_copy_paste TEXT NOT NULL,
  qr_image_url TEXT NOT NULL,
  external_status TEXT NOT NULL,
  expiration TEXT,
  original_created_at TEXT NOT NULL,
  original_updated_at TEXT NOT NULL,
  quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  canonical_deposit_entry_id TEXT NOT NULL,
  quarantine_reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deposit_order_duplicate_event_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  original_event_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  deposit_entry_id TEXT NOT NULL,
  qr_id TEXT,
  source TEXT NOT NULL,
  external_status TEXT NOT NULL,
  bank_tx_id TEXT,
  blockchain_tx_id TEXT,
  raw_payload TEXT NOT NULL,
  original_received_at TEXT NOT NULL,
  quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  canonical_deposit_entry_id TEXT NOT NULL,
  quarantine_reason TEXT NOT NULL
);

WITH ranked_deposits AS (
  SELECT
    deposits.*,
    FIRST_VALUE(deposit_entry_id) OVER (
      PARTITION BY tenant_id, order_id
      ORDER BY
        CASE external_status
          WHEN 'depix_sent' THEN 0
          WHEN 'pending_pix2fa' THEN 1
          WHEN 'pending' THEN 2
          WHEN 'expired' THEN 3
          ELSE 4
        END,
        julianday(updated_at) DESC,
        julianday(created_at) DESC,
        deposit_entry_id DESC
    ) AS canonical_deposit_entry_id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, order_id
      ORDER BY
        CASE external_status
          WHEN 'depix_sent' THEN 0
          WHEN 'pending_pix2fa' THEN 1
          WHEN 'pending' THEN 2
          WHEN 'expired' THEN 3
          ELSE 4
        END,
        julianday(updated_at) DESC,
        julianday(created_at) DESC,
        deposit_entry_id DESC
    ) AS duplicate_rank
  FROM deposits
)
INSERT OR IGNORE INTO deposit_order_duplicate_quarantine (
  tenant_id,
  order_id,
  deposit_entry_id,
  qr_id,
  nonce,
  qr_copy_paste,
  qr_image_url,
  external_status,
  expiration,
  original_created_at,
  original_updated_at,
  canonical_deposit_entry_id,
  quarantine_reason
)
SELECT
  tenant_id,
  order_id,
  deposit_entry_id,
  qr_id,
  nonce,
  qr_copy_paste,
  qr_image_url,
  external_status,
  expiration,
  created_at,
  updated_at,
  canonical_deposit_entry_id,
  'tenant_order_duplicate_before_unique_index'
FROM ranked_deposits
WHERE duplicate_rank > 1;

INSERT INTO deposit_order_duplicate_event_quarantine (
  original_event_id,
  tenant_id,
  order_id,
  deposit_entry_id,
  qr_id,
  source,
  external_status,
  bank_tx_id,
  blockchain_tx_id,
  raw_payload,
  original_received_at,
  canonical_deposit_entry_id,
  quarantine_reason
)
SELECT
  deposit_events.id,
  deposit_events.tenant_id,
  deposit_events.order_id,
  deposit_events.deposit_entry_id,
  deposit_events.qr_id,
  deposit_events.source,
  deposit_events.external_status,
  deposit_events.bank_tx_id,
  deposit_events.blockchain_tx_id,
  deposit_events.raw_payload,
  deposit_events.received_at,
  deposit_order_duplicate_quarantine.canonical_deposit_entry_id,
  'tenant_order_duplicate_before_unique_index'
FROM deposit_events
JOIN deposit_order_duplicate_quarantine
  ON deposit_order_duplicate_quarantine.tenant_id = deposit_events.tenant_id
 AND deposit_order_duplicate_quarantine.deposit_entry_id = deposit_events.deposit_entry_id
WHERE NOT EXISTS (
  SELECT 1
  FROM deposit_order_duplicate_event_quarantine existing_quarantine
  WHERE existing_quarantine.original_event_id = deposit_events.id
);

DELETE FROM deposit_events
WHERE EXISTS (
  SELECT 1
  FROM deposit_order_duplicate_quarantine
  WHERE deposit_order_duplicate_quarantine.tenant_id = deposit_events.tenant_id
    AND deposit_order_duplicate_quarantine.deposit_entry_id = deposit_events.deposit_entry_id
);

DELETE FROM deposits
WHERE EXISTS (
  SELECT 1
  FROM deposit_order_duplicate_quarantine
  WHERE deposit_order_duplicate_quarantine.tenant_id = deposits.tenant_id
    AND deposit_order_duplicate_quarantine.deposit_entry_id = deposits.deposit_entry_id
);

CREATE UNIQUE INDEX IF NOT EXISTS deposits_tenant_order_unique_idx
  ON deposits (tenant_id, order_id);

CREATE INDEX IF NOT EXISTS deposit_order_duplicate_quarantine_tenant_order_idx
  ON deposit_order_duplicate_quarantine (tenant_id, order_id);

CREATE INDEX IF NOT EXISTS deposit_order_duplicate_event_quarantine_tenant_order_idx
  ON deposit_order_duplicate_event_quarantine (tenant_id, order_id);
