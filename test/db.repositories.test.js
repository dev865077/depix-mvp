/**
 * Testes de persistencia do MVP.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getDatabase } from "../src/db/client.js";
import { createDepositEvent, listDepositEventsByDepositId } from "../src/db/repositories/deposit-events-repository.js";
import { createDeposit, getDepositById, updateDepositById } from "../src/db/repositories/deposits-repository.js";
import { createOrder, getOrderById, updateOrderById } from "../src/db/repositories/orders-repository.js";

const INITIAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS orders (
    tenant_id TEXT NOT NULL,
    order_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'telegram',
    product_type TEXT NOT NULL,
    amount_in_cents INTEGER,
    wallet_address TEXT,
    current_step TEXT NOT NULL DEFAULT 'draft',
    status TEXT NOT NULL DEFAULT 'draft',
    split_address TEXT,
    split_fee TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id)",
  "CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)",
  "CREATE INDEX IF NOT EXISTS orders_tenant_id_idx ON orders (tenant_id)",
  `CREATE TABLE IF NOT EXISTS deposits (
    tenant_id TEXT NOT NULL,
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
  )`,
  "CREATE INDEX IF NOT EXISTS deposits_order_id_idx ON deposits (order_id)",
  "CREATE INDEX IF NOT EXISTS deposits_external_status_idx ON deposits (external_status)",
  "CREATE UNIQUE INDEX IF NOT EXISTS deposits_nonce_unique_idx ON deposits (nonce)",
  "CREATE INDEX IF NOT EXISTS deposits_tenant_id_idx ON deposits (tenant_id)",
  "CREATE INDEX IF NOT EXISTS deposits_tenant_order_idx ON deposits (tenant_id, order_id)",
  `CREATE TABLE IF NOT EXISTS deposit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    tenant_id TEXT NOT NULL,
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
  )`,
  "CREATE INDEX IF NOT EXISTS deposit_events_order_id_idx ON deposit_events (order_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_deposit_id_idx ON deposit_events (deposit_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_source_idx ON deposit_events (source)",
  "CREATE INDEX IF NOT EXISTS deposit_events_tenant_id_idx ON deposit_events (tenant_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_tenant_deposit_idx ON deposit_events (tenant_id, deposit_id)",
  `CREATE UNIQUE INDEX IF NOT EXISTS deposit_events_idempotency_unique_idx ON deposit_events (
    tenant_id,
    deposit_id,
    source,
    external_status,
    IFNULL(bank_tx_id, ''),
    IFNULL(blockchain_tx_id, ''),
    raw_payload
  )`,
];

export function readInitialMigrationSql() {
  return INITIAL_SCHEMA_STATEMENTS;
}

export async function resetDatabaseSchema() {
  const resetStatements = [
    "DROP TABLE IF EXISTS deposit_events",
    "DROP TABLE IF EXISTS deposits",
    "DROP TABLE IF EXISTS orders",
    ...readInitialMigrationSql(),
  ];

  await env.DB.batch(resetStatements.map((statement) => env.DB.prepare(statement)));
}

export async function assertPersistenceFlow() {
  await resetDatabaseSchema();

  const db = getDatabase(env);

  await createOrder(db, {
    tenantId: "alpha",
    orderId: "order_test_001",
    userId: "telegram_user_001",
    channel: "telegram",
    productType: "depix",
    amountInCents: 15000,
    walletAddress: "depix_wallet_abc",
    currentStep: "wallet",
    status: "draft",
    splitAddress: "split_wallet_xyz",
    splitFee: "0.50",
  });

  await createDeposit(db, {
    tenantId: "alpha",
    depositId: "deposit_test_001",
    orderId: "order_test_001",
    nonce: "nonce_test_001",
    qrCopyPaste: "00020101021226880014br.gov.bcb.pix2566pix.example/qr/123",
    qrImageUrl: "https://example.com/qr/deposit_test_001.png",
    externalStatus: "pending",
    expiration: "2026-04-14T01:00:00Z",
  });

  await createDepositEvent(db, {
    tenantId: "alpha",
    orderId: "order_test_001",
    depositId: "deposit_test_001",
    source: "webhook",
    externalStatus: "pending",
    bankTxId: "bank_tx_001",
    blockchainTxId: null,
    rawPayload: JSON.stringify({ status: "pending", depositId: "deposit_test_001" }),
  });

  const updatedOrder = await updateOrderById(db, "alpha", "order_test_001", {
    currentStep: "completed",
    status: "paid",
  });
  const updatedDeposit = await updateDepositById(db, "alpha", "deposit_test_001", {
    externalStatus: "depix_sent",
  });
  const savedOrder = await getOrderById(db, "alpha", "order_test_001");
  const savedDeposit = await getDepositById(db, "alpha", "deposit_test_001");
  const savedEvents = await listDepositEventsByDepositId(db, "alpha", "deposit_test_001");

  expect(updatedOrder?.tenantId).toBe("alpha");
  expect(updatedOrder?.currentStep).toBe("completed");
  expect(updatedOrder?.status).toBe("paid");
  expect(updatedDeposit?.tenantId).toBe("alpha");
  expect(updatedDeposit?.externalStatus).toBe("depix_sent");
  expect(savedOrder?.tenantId).toBe("alpha");
  expect(savedOrder?.orderId).toBe("order_test_001");
  expect(savedOrder?.status).toBe("paid");
  expect(savedDeposit?.tenantId).toBe("alpha");
  expect(savedDeposit?.orderId).toBe("order_test_001");
  expect(savedDeposit?.nonce).toBe("nonce_test_001");
  expect(savedDeposit?.externalStatus).toBe("depix_sent");
  expect(savedEvents).toHaveLength(1);
  expect(savedEvents[0]?.tenantId).toBe("alpha");
  expect(savedEvents[0]?.orderId).toBe("order_test_001");
  expect(savedEvents[0]?.depositId).toBe("deposit_test_001");
}

describe("database repositories", () => {
  it("persists orders, deposits and deposit events with tenant isolation", assertPersistenceFlow);
});
