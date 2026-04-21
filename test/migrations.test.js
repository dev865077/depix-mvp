// @vitest-pool cloudflare
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import migration0000 from "../migrations/0000_initial_schema.sql?raw";
import migration0001 from "../migrations/0001_multi_tenant.sql?raw";
import migration0002 from "../migrations/0002_deposit_event_idempotency.sql?raw";
import migration0003 from "../migrations/0003_deposit_entry_id_and_qr_id.sql?raw";
import migration0004 from "../migrations/0004_telegram_chat_id.sql?raw";
import migration0005 from "../migrations/0005_deposit_order_uniqueness.sql?raw";
import migration0006 from "../migrations/0006_scheduled_deposit_reconciliation_claims.sql?raw";
import migration0007 from "../migrations/0007_telegram_canonical_message.sql?raw";

const MIGRATIONS = [
  migration0000,
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
];

function readMigrationStatements(sql) {
  return sql
    .split(/;\s*\n/gu)
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/--.*$/gmu, "").trim().length > 0)
    .map((statement) => `${statement};`);
}

async function resetMigratedSchema() {
  const teardownStatements = [
    "DROP TABLE IF EXISTS scheduled_deposit_reconciliation_claims",
    "DROP TABLE IF EXISTS deposit_order_duplicate_event_quarantine",
    "DROP TABLE IF EXISTS deposit_order_duplicate_quarantine",
    "DROP TABLE IF EXISTS deposit_events",
    "DROP TABLE IF EXISTS deposits",
    "DROP TABLE IF EXISTS orders",
    "DROP TABLE IF EXISTS deposit_events_v2",
    "DROP TABLE IF EXISTS deposits_v2",
  ];

  await env.DB.batch(teardownStatements.map((statement) => env.DB.prepare(statement)));
}

describe("migrations", () => {
  it("applies the full migration chain without duplicating canonical Telegram message columns", async function assertSequentialMigrations() {
    await resetMigratedSchema();

    for (const migration of MIGRATIONS) {
      const statements = readMigrationStatements(migration);
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
    }

    const tableInfo = await env.DB.prepare("PRAGMA table_info('orders')").all();
    const canonicalMessageIdColumns = tableInfo.results.filter((column) => column.name === "telegram_canonical_message_id");
    const canonicalMessageKindColumns = tableInfo.results.filter((column) => column.name === "telegram_canonical_message_kind");

    expect(canonicalMessageIdColumns).toHaveLength(1);
    expect(canonicalMessageKindColumns).toHaveLength(1);
  });
});
