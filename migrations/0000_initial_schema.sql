-- Migration inicial do MVP.
-- Este arquivo cria as três estruturas centrais da persistência: orders,
-- deposits e deposit_events, com índices e chaves estrangeiras para manter
-- rastreabilidade entre pedido, cobrança e histórico de eventos.

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'telegram',
  product_type TEXT NOT NULL,
  telegram_canonical_message_id INTEGER,
  telegram_canonical_message_kind TEXT,
  amount_in_cents INTEGER,
  wallet_address TEXT,
  current_step TEXT NOT NULL DEFAULT 'draft',
  status TEXT NOT NULL DEFAULT 'draft',
  split_address TEXT,
  split_fee TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

CREATE TABLE IF NOT EXISTS deposits (
  deposit_id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  qr_copy_paste TEXT NOT NULL,
  qr_image_url TEXT NOT NULL,
  external_status TEXT NOT NULL DEFAULT 'pending',
  expiration TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS deposits_order_id_idx ON deposits (order_id);
CREATE INDEX IF NOT EXISTS deposits_external_status_idx ON deposits (external_status);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_nonce_unique_idx ON deposits (nonce);

CREATE TABLE IF NOT EXISTS deposit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  order_id TEXT NOT NULL,
  deposit_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_status TEXT NOT NULL,
  bank_tx_id TEXT,
  blockchain_tx_id TEXT,
  raw_payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (deposit_id) REFERENCES deposits(deposit_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS deposit_events_order_id_idx ON deposit_events (order_id);
CREATE INDEX IF NOT EXISTS deposit_events_deposit_id_idx ON deposit_events (deposit_id);
CREATE INDEX IF NOT EXISTS deposit_events_source_idx ON deposit_events (source);
