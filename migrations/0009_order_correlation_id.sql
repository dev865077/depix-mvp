-- Persiste um correlation_id canonico por pedido para juntar logs do Telegram,
-- webhook e integracoes externas sem depender apenas de requestId efemero.

ALTER TABLE orders ADD COLUMN correlation_id TEXT;

UPDATE orders
SET correlation_id = order_id
WHERE correlation_id IS NULL
   OR TRIM(correlation_id) = '';

CREATE INDEX IF NOT EXISTS orders_correlation_id_idx ON orders (correlation_id);
