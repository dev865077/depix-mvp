-- Persiste o destino real de chat do Telegram no agregado do pedido.
--
-- A coluna e nullable por compatibilidade: pedidos historicos continuam
-- legiveis e ficam explicitamente sem destino assincrono seguro ate que um
-- novo update do mesmo usuario/tenant consiga hidratar o campo.

ALTER TABLE orders ADD COLUMN telegram_chat_id TEXT;

CREATE INDEX IF NOT EXISTS orders_tenant_user_channel_chat_idx
  ON orders (tenant_id, user_id, channel, telegram_chat_id);
