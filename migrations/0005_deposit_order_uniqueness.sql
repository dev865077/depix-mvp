-- Reforca a invariavel financeira do MVP: um pedido local pode ter no maximo
-- um deposito Pix/DePix associado.
--
-- A regra e intencionalmente `tenant_id + order_id`, e nao apenas "um deposito
-- ativo", porque o MVP ainda nao oferece refund, chargeback, split em varias
-- cobrancas ou recriacao de cobranca dentro do mesmo pedido. Se esse produto
-- evoluir, a regra deve mudar junto com uma modelagem explicita desses casos.

CREATE UNIQUE INDEX IF NOT EXISTS deposits_tenant_order_unique_idx
  ON deposits (tenant_id, order_id);
