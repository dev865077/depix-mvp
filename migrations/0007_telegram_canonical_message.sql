-- Persiste a mensagem canônica do pedido no Telegram para permitir edição
-- do mesmo payload ao longo de QR/status/confirmação final.

ALTER TABLE orders ADD COLUMN telegram_canonical_message_id INTEGER;
ALTER TABLE orders ADD COLUMN telegram_canonical_message_kind TEXT;
