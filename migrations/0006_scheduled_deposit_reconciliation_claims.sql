-- Separa o lock de reconciliacao agendada do campo de status de negocio do
-- deposito. O cron nao deve escrever marcadores internos em `deposits.external_status`.

CREATE TABLE IF NOT EXISTS scheduled_deposit_reconciliation_claims (
  tenant_id TEXT NOT NULL,
  deposit_entry_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, deposit_entry_id),
  FOREIGN KEY (deposit_entry_id) REFERENCES deposits(deposit_entry_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS scheduled_deposit_reconciliation_claims_claimed_at_idx
  ON scheduled_deposit_reconciliation_claims (claimed_at);
