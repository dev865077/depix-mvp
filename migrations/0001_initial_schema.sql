-- Este arquivo contem o schema inicial de `D1` para a fundacao do MVP.
-- Ele foi separado do codigo para funcionar como documentacao tecnica viva,
-- facilitar revisao e permitir evolucao versionada das migracoes.

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  product_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  conversation_state TEXT NOT NULL,
  amount_in_cents INTEGER,
  depix_address TEXT,
  nonce TEXT,
  deposit_id TEXT,
  qr_id TEXT,
  qr_copy_paste TEXT,
  qr_image_url TEXT,
  expires_at TEXT,
  telegram_chat_id TEXT,
  telegram_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_nonce ON orders (nonce);
CREATE INDEX IF NOT EXISTS idx_orders_deposit_id ON orders (deposit_id);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id TEXT PRIMARY KEY,
  telegram_user_id TEXT,
  state TEXT NOT NULL,
  active_order_id TEXT,
  product_type TEXT,
  amount_in_cents INTEGER,
  depix_address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (active_order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_sessions_state
  ON telegram_sessions (state);

CREATE TABLE IF NOT EXISTS external_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  deposit_id TEXT,
  qr_id TEXT,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  external_status TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_external_events_order_id
  ON external_events (order_id);

CREATE INDEX IF NOT EXISTS idx_external_events_deposit_id
  ON external_events (deposit_id);
