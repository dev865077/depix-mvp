-- Explicita `depositEntryId` e `qrId` no schema local.
--
-- O schema antigo usava apenas `deposit_id`, entao esta migracao preserva o
-- valor legado em ambos os campos novos para nao perder rastreabilidade nem
-- deixar linhas antigas inacessiveis logo apos o deploy.
--
-- A reconciliacao posterior pode substituir `qr_id` quando a Eulen expuser um
-- valor canonico diferente via `deposit-status` ou webhook.

DROP INDEX IF EXISTS deposit_events_idempotency_unique_idx;
DROP INDEX IF EXISTS deposit_events_tenant_deposit_idx;
DROP INDEX IF EXISTS deposit_events_deposit_id_idx;
DROP INDEX IF EXISTS deposits_tenant_order_idx;
DROP INDEX IF EXISTS deposits_tenant_id_idx;
DROP INDEX IF EXISTS deposits_nonce_unique_idx;
DROP INDEX IF EXISTS deposits_external_status_idx;
DROP INDEX IF EXISTS deposits_order_id_idx;

CREATE TABLE deposits_v2 (
  deposit_entry_id TEXT PRIMARY KEY NOT NULL,
  qr_id TEXT,
  order_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  qr_copy_paste TEXT NOT NULL,
  qr_image_url TEXT NOT NULL,
  external_status TEXT NOT NULL DEFAULT 'pending',
  expiration TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id TEXT NOT NULL DEFAULT 'legacy',
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
);

INSERT INTO deposits_v2 (
  deposit_entry_id,
  qr_id,
  order_id,
  nonce,
  qr_copy_paste,
  qr_image_url,
  external_status,
  expiration,
  created_at,
  updated_at,
  tenant_id
)
SELECT
  deposit_id,
  deposit_id,
  order_id,
  nonce,
  qr_copy_paste,
  qr_image_url,
  external_status,
  expiration,
  created_at,
  updated_at,
  tenant_id
FROM deposits;

CREATE TABLE deposit_events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'legacy',
  order_id TEXT NOT NULL,
  deposit_entry_id TEXT NOT NULL,
  qr_id TEXT,
  source TEXT NOT NULL,
  external_status TEXT NOT NULL,
  bank_tx_id TEXT,
  blockchain_tx_id TEXT,
  raw_payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (deposit_entry_id) REFERENCES deposits_v2(deposit_entry_id) ON DELETE CASCADE
);

INSERT INTO deposit_events_v2 (
  id,
  tenant_id,
  order_id,
  deposit_entry_id,
  qr_id,
  source,
  external_status,
  bank_tx_id,
  blockchain_tx_id,
  raw_payload,
  received_at
)
SELECT
  id,
  tenant_id,
  order_id,
  deposit_id,
  deposit_id,
  source,
  external_status,
  bank_tx_id,
  blockchain_tx_id,
  raw_payload,
  received_at
FROM deposit_events;

DROP TABLE deposit_events;
DROP TABLE deposits;

ALTER TABLE deposits_v2 RENAME TO deposits;
ALTER TABLE deposit_events_v2 RENAME TO deposit_events;

CREATE INDEX IF NOT EXISTS deposits_order_id_idx ON deposits (order_id);
CREATE INDEX IF NOT EXISTS deposits_external_status_idx ON deposits (external_status);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_qr_id_unique_idx ON deposits (qr_id);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_nonce_unique_idx ON deposits (nonce);
CREATE INDEX IF NOT EXISTS deposits_tenant_id_idx ON deposits (tenant_id);
CREATE INDEX IF NOT EXISTS deposits_tenant_order_idx ON deposits (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS deposits_tenant_qr_idx ON deposits (tenant_id, qr_id);

CREATE INDEX IF NOT EXISTS deposit_events_order_id_idx ON deposit_events (order_id);
CREATE INDEX IF NOT EXISTS deposit_events_deposit_entry_id_idx ON deposit_events (deposit_entry_id);
CREATE INDEX IF NOT EXISTS deposit_events_qr_id_idx ON deposit_events (qr_id);
CREATE INDEX IF NOT EXISTS deposit_events_source_idx ON deposit_events (source);
CREATE INDEX IF NOT EXISTS deposit_events_tenant_id_idx ON deposit_events (tenant_id);
CREATE INDEX IF NOT EXISTS deposit_events_tenant_deposit_entry_idx ON deposit_events (tenant_id, deposit_entry_id);
CREATE INDEX IF NOT EXISTS deposit_events_tenant_qr_idx ON deposit_events (tenant_id, qr_id);

CREATE UNIQUE INDEX IF NOT EXISTS deposit_events_idempotency_unique_idx
ON deposit_events (
  tenant_id,
  deposit_entry_id,
  IFNULL(qr_id, ''),
  source,
  external_status,
  IFNULL(bank_tx_id, ''),
  IFNULL(blockchain_tx_id, ''),
  raw_payload
);
