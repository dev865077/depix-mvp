-- Adapta a persistencia para isolar dados por tenant.
-- O valor 'legacy' preserva compatibilidade com registros eventualmente ja
-- existentes antes da mudanca multi-tenant.

ALTER TABLE orders ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE deposits ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE deposit_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS orders_tenant_id_idx ON orders (tenant_id);
CREATE INDEX IF NOT EXISTS deposits_tenant_id_idx ON deposits (tenant_id);
CREATE INDEX IF NOT EXISTS deposit_events_tenant_id_idx ON deposit_events (tenant_id);
CREATE INDEX IF NOT EXISTS deposits_tenant_order_idx ON deposits (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS deposit_events_tenant_deposit_idx ON deposit_events (tenant_id, deposit_id);
