/**
 * Testes de persistencia do MVP.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getDatabase } from "../src/db/client.js";
import { createDepositEvent, listDepositEventsByDepositEntryId } from "../src/db/repositories/deposit-events-repository.js";
import {
  createDeposit,
  getDepositByDepositEntryId,
  getDepositByQrId,
  updateDepositByDepositEntryId,
} from "../src/db/repositories/deposits-repository.js";
import {
  createOrder,
  getOrderById,
  getLatestOrderByUser,
  getLatestOpenOrderByUser,
  hydrateOrderTelegramChatIdIfMissing,
  updateOrderById,
  updateOrderByIdWithStepGuard,
} from "../src/db/repositories/orders-repository.js";
import { ORDER_PROGRESS_EVENTS, ORDER_PROGRESS_STATES, advanceOrderProgression } from "../src/order-flow/order-progress-machine.js";

const LEGACY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS orders (
    tenant_id TEXT NOT NULL,
    order_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'telegram',
    product_type TEXT NOT NULL,
    telegram_chat_id TEXT,
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
  "CREATE INDEX IF NOT EXISTS orders_tenant_user_channel_chat_idx ON orders (tenant_id, user_id, channel, telegram_chat_id)",
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

const CURRENT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS orders (
    tenant_id TEXT NOT NULL,
    order_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'telegram',
    product_type TEXT NOT NULL,
    telegram_chat_id TEXT,
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
  "CREATE INDEX IF NOT EXISTS orders_tenant_user_channel_chat_idx ON orders (tenant_id, user_id, channel, telegram_chat_id)",
  `CREATE TABLE IF NOT EXISTS deposits (
    tenant_id TEXT NOT NULL,
    deposit_entry_id TEXT PRIMARY KEY NOT NULL,
    qr_id TEXT,
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
  "CREATE UNIQUE INDEX IF NOT EXISTS deposits_qr_id_unique_idx ON deposits (qr_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS deposits_nonce_unique_idx ON deposits (nonce)",
  "CREATE INDEX IF NOT EXISTS deposits_tenant_id_idx ON deposits (tenant_id)",
  "CREATE INDEX IF NOT EXISTS deposits_tenant_order_idx ON deposits (tenant_id, order_id)",
  "CREATE INDEX IF NOT EXISTS deposits_tenant_qr_idx ON deposits (tenant_id, qr_id)",
  `CREATE TABLE IF NOT EXISTS deposit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    tenant_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    deposit_entry_id TEXT NOT NULL,
    qr_id TEXT,
    source TEXT NOT NULL,
    external_status TEXT NOT NULL,
    bank_tx_id TEXT,
    blockchain_tx_id TEXT,
    raw_payload TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
    FOREIGN KEY (deposit_entry_id) REFERENCES deposits(deposit_entry_id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS deposit_events_order_id_idx ON deposit_events (order_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_deposit_entry_id_idx ON deposit_events (deposit_entry_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_qr_id_idx ON deposit_events (qr_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_source_idx ON deposit_events (source)",
  "CREATE INDEX IF NOT EXISTS deposit_events_tenant_id_idx ON deposit_events (tenant_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_tenant_deposit_entry_idx ON deposit_events (tenant_id, deposit_entry_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_tenant_qr_idx ON deposit_events (tenant_id, qr_id)",
  `CREATE UNIQUE INDEX IF NOT EXISTS deposit_events_idempotency_unique_idx ON deposit_events (
    tenant_id,
    deposit_entry_id,
    IFNULL(qr_id, ''),
    source,
    external_status,
    IFNULL(bank_tx_id, ''),
    IFNULL(blockchain_tx_id, ''),
    raw_payload
  )`,
];

const MIGRATION_0003_STATEMENTS = [
  "DROP INDEX IF EXISTS deposit_events_idempotency_unique_idx",
  "DROP INDEX IF EXISTS deposit_events_tenant_deposit_idx",
  "DROP INDEX IF EXISTS deposit_events_deposit_id_idx",
  "DROP INDEX IF EXISTS deposits_tenant_order_idx",
  "DROP INDEX IF EXISTS deposits_tenant_id_idx",
  "DROP INDEX IF EXISTS deposits_nonce_unique_idx",
  "DROP INDEX IF EXISTS deposits_external_status_idx",
  "DROP INDEX IF EXISTS deposits_order_id_idx",
  `CREATE TABLE deposits_v2 (
    deposit_entry_id TEXT PRIMARY KEY NOT NULL,
    qr_id TEXT,
    order_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    qr_copy_paste TEXT NOT NULL,
    qr_image_url TEXT NOT NULL,
    external_status TEXT NOT NULL DEFAULT 'pending',
    expiration TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tenant_id TEXT NOT NULL DEFAULT 'legacy',
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
  )`,
  `INSERT INTO deposits_v2 (
    deposit_entry_id,
    qr_id,
    order_id,
    nonce,
    qr_copy_paste,
    qr_image_url,
    external_status,
    expiration,
    created_at,
    updated_at,
    tenant_id
  )
  SELECT
    deposit_id,
    deposit_id,
    order_id,
    nonce,
    qr_copy_paste,
    qr_image_url,
    external_status,
    expiration,
    created_at,
    updated_at,
    tenant_id
  FROM deposits`,
  `CREATE TABLE deposit_events_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'legacy',
    order_id TEXT NOT NULL,
    deposit_entry_id TEXT NOT NULL,
    qr_id TEXT,
    source TEXT NOT NULL,
    external_status TEXT NOT NULL,
    bank_tx_id TEXT,
    blockchain_tx_id TEXT,
    raw_payload TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
    FOREIGN KEY (deposit_entry_id) REFERENCES deposits_v2(deposit_entry_id) ON DELETE CASCADE
  )`,
  `INSERT INTO deposit_events_v2 (
    id,
    tenant_id,
    order_id,
    deposit_entry_id,
    qr_id,
    source,
    external_status,
    bank_tx_id,
    blockchain_tx_id,
    raw_payload,
    received_at
  )
  SELECT
    id,
    tenant_id,
    order_id,
    deposit_id,
    deposit_id,
    source,
    external_status,
    bank_tx_id,
    blockchain_tx_id,
    raw_payload,
    received_at
  FROM deposit_events`,
  "DROP TABLE deposit_events",
  "DROP TABLE deposits",
  "ALTER TABLE deposits_v2 RENAME TO deposits",
  "ALTER TABLE deposit_events_v2 RENAME TO deposit_events",
  "CREATE INDEX IF NOT EXISTS deposits_order_id_idx ON deposits (order_id)",
  "CREATE INDEX IF NOT EXISTS deposits_external_status_idx ON deposits (external_status)",
  "CREATE UNIQUE INDEX IF NOT EXISTS deposits_qr_id_unique_idx ON deposits (qr_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS deposits_nonce_unique_idx ON deposits (nonce)",
  "CREATE INDEX IF NOT EXISTS deposits_tenant_id_idx ON deposits (tenant_id)",
  "CREATE INDEX IF NOT EXISTS deposits_tenant_order_idx ON deposits (tenant_id, order_id)",
  "CREATE INDEX IF NOT EXISTS deposits_tenant_qr_idx ON deposits (tenant_id, qr_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_order_id_idx ON deposit_events (order_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_deposit_entry_id_idx ON deposit_events (deposit_entry_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_qr_id_idx ON deposit_events (qr_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_source_idx ON deposit_events (source)",
  "CREATE INDEX IF NOT EXISTS deposit_events_tenant_id_idx ON deposit_events (tenant_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_tenant_deposit_entry_idx ON deposit_events (tenant_id, deposit_entry_id)",
  "CREATE INDEX IF NOT EXISTS deposit_events_tenant_qr_idx ON deposit_events (tenant_id, qr_id)",
  `CREATE UNIQUE INDEX IF NOT EXISTS deposit_events_idempotency_unique_idx
  ON deposit_events (
    tenant_id,
    deposit_entry_id,
    IFNULL(qr_id, ''),
    source,
    external_status,
    IFNULL(bank_tx_id, ''),
    IFNULL(blockchain_tx_id, ''),
    raw_payload
  )`,
];

export function readInitialMigrationSql() {
  return CURRENT_SCHEMA_STATEMENTS;
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

export async function resetLegacyDatabaseSchema() {
  const resetStatements = [
    "DROP TABLE IF EXISTS deposit_events",
    "DROP TABLE IF EXISTS deposits",
    "DROP TABLE IF EXISTS orders",
    ...LEGACY_SCHEMA_STATEMENTS,
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
    telegramChatId: "telegram_chat_001",
    amountInCents: 15000,
    walletAddress: "depix_wallet_abc",
    currentStep: "wallet",
    status: "draft",
    splitAddress: "split_wallet_xyz",
    splitFee: "0.50",
  });

  await createDeposit(db, {
    tenantId: "alpha",
    depositEntryId: "deposit_entry_test_001",
    qrId: "qr_test_001",
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
    depositEntryId: "deposit_entry_test_001",
    qrId: "qr_test_001",
    source: "webhook",
    externalStatus: "pending",
    bankTxId: "bank_tx_001",
    blockchainTxId: null,
    rawPayload: JSON.stringify({ status: "pending", qrId: "qr_test_001" }),
  });

  const updatedOrder = await updateOrderById(db, "alpha", "order_test_001", {
    currentStep: "completed",
    status: "paid",
  });
  const updatedDeposit = await updateDepositByDepositEntryId(db, "alpha", "deposit_entry_test_001", {
    externalStatus: "depix_sent",
  });
  const savedOrder = await getOrderById(db, "alpha", "order_test_001");
  const savedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_test_001");
  const savedDepositByQrId = await getDepositByQrId(db, "alpha", "qr_test_001");
  const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_test_001");

  expect(updatedOrder?.tenantId).toBe("alpha");
  expect(updatedOrder?.currentStep).toBe("completed");
  expect(updatedOrder?.status).toBe("paid");
  expect(updatedDeposit?.tenantId).toBe("alpha");
  expect(updatedDeposit?.externalStatus).toBe("depix_sent");
  expect(savedOrder?.tenantId).toBe("alpha");
  expect(savedOrder?.orderId).toBe("order_test_001");
  expect(savedOrder?.telegramChatId).toBe("telegram_chat_001");
  expect(savedOrder?.status).toBe("paid");
  expect(savedDeposit?.tenantId).toBe("alpha");
  expect(savedDeposit?.depositEntryId).toBe("deposit_entry_test_001");
  expect(savedDeposit?.qrId).toBe("qr_test_001");
  expect(savedDeposit?.orderId).toBe("order_test_001");
  expect(savedDeposit?.nonce).toBe("nonce_test_001");
  expect(savedDeposit?.externalStatus).toBe("depix_sent");
  expect(savedDepositByQrId?.depositEntryId).toBe("deposit_entry_test_001");
  expect(savedEvents).toHaveLength(1);
  expect(savedEvents[0]?.tenantId).toBe("alpha");
  expect(savedEvents[0]?.orderId).toBe("order_test_001");
  expect(savedEvents[0]?.depositEntryId).toBe("deposit_entry_test_001");
  expect(savedEvents[0]?.qrId).toBe("qr_test_001");
}

async function assertLegacyMigrationBackfill() {
  await resetLegacyDatabaseSchema();

  const legacyStatements = [
    `INSERT INTO orders (
      tenant_id,
      order_id,
      user_id,
      channel,
      product_type,
      amount_in_cents,
      current_step,
      status
    ) VALUES ('alpha', 'order_legacy_001', 'telegram_legacy_001', 'telegram', 'depix', 1000, 'awaiting_payment', 'pending')`,
    `INSERT INTO deposits (
      tenant_id,
      deposit_id,
      order_id,
      nonce,
      qr_copy_paste,
      qr_image_url,
      external_status,
      expiration
    ) VALUES (
      'alpha',
      'legacy_deposit_001',
      'order_legacy_001',
      'nonce_legacy_001',
      'pix-copy-paste',
      'https://example.com/qr/legacy.png',
      'pending',
      '2026-04-18T04:00:00Z'
    )`,
    `INSERT INTO deposit_events (
      tenant_id,
      order_id,
      deposit_id,
      source,
      external_status,
      raw_payload
    ) VALUES (
      'alpha',
      'order_legacy_001',
      'legacy_deposit_001',
      'webhook',
      'pending',
      '{"status":"pending"}'
    )`,
  ];

  await env.DB.batch(legacyStatements.map((statement) => env.DB.prepare(statement)));

  await env.DB.batch(MIGRATION_0003_STATEMENTS.map((statement) => env.DB.prepare(statement)));

  const db = getDatabase(env);
  const migratedDepositByEntryId = await getDepositByDepositEntryId(db, "alpha", "legacy_deposit_001");
  const migratedDepositByQrId = await getDepositByQrId(db, "alpha", "legacy_deposit_001");
  const migratedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "legacy_deposit_001");

  expect(migratedDepositByEntryId?.depositEntryId).toBe("legacy_deposit_001");
  expect(migratedDepositByEntryId?.qrId).toBe("legacy_deposit_001");
  expect(migratedDepositByQrId?.depositEntryId).toBe("legacy_deposit_001");
  expect(migratedEvents).toHaveLength(1);
  expect(migratedEvents[0]?.depositEntryId).toBe("legacy_deposit_001");
  expect(migratedEvents[0]?.qrId).toBe("legacy_deposit_001");
}

async function assertGuardedOrderTransitionWrite() {
  await resetDatabaseSchema();

  const db = getDatabase(env);
  const tenantId = "alpha";
  const orderId = "order_guarded_001";

  await createOrder(db, {
    tenantId,
    orderId,
    userId: "telegram_user_guarded_001",
    channel: "telegram",
    productType: "depix",
    currentStep: ORDER_PROGRESS_STATES.AMOUNT,
    status: "draft",
  });

  const transition = advanceOrderProgression({
    currentStep: ORDER_PROGRESS_STATES.AMOUNT,
    context: {
      tenantId,
      orderId,
      userId: "telegram_user_guarded_001",
    },
    event: {
      type: ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED,
      amountInCents: 15000,
    },
  });

  const updated = await updateOrderByIdWithStepGuard(
    db,
    transition.persistenceGuard.tenantId,
    transition.persistenceGuard.orderId,
    transition.persistenceGuard.expectedCurrentStep,
    transition.orderPatch,
  );
  const staleWrite = await updateOrderByIdWithStepGuard(db, tenantId, orderId, ORDER_PROGRESS_STATES.AMOUNT, {
    currentStep: ORDER_PROGRESS_STATES.CONFIRMATION,
    status: "draft",
  });
  const missingWrite = await updateOrderByIdWithStepGuard(db, tenantId, "missing_order", ORDER_PROGRESS_STATES.AMOUNT, {
    currentStep: ORDER_PROGRESS_STATES.WALLET,
    status: "draft",
  });

  expect(updated.didUpdate).toBe(true);
  expect(updated.conflict).toBe(false);
  expect(updated.notFound).toBe(false);
  expect(updated.reason).toBe("updated");
  expect(updated.order?.currentStep).toBe(ORDER_PROGRESS_STATES.WALLET);
  expect(updated.order?.amountInCents).toBe(15000);
  expect(staleWrite.didUpdate).toBe(false);
  expect(staleWrite.conflict).toBe(true);
  expect(staleWrite.notFound).toBe(false);
  expect(staleWrite.reason).toBe("step_conflict");
  expect(staleWrite.order?.currentStep).toBe(ORDER_PROGRESS_STATES.WALLET);
  expect(missingWrite.didUpdate).toBe(false);
  expect(missingWrite.conflict).toBe(false);
  expect(missingWrite.notFound).toBe(true);
  expect(missingWrite.reason).toBe("not_found");
  expect(missingWrite.order).toBeNull();
}

async function assertLatestOpenOrderLookup() {
  await resetDatabaseSchema();

  const db = getDatabase(env);
  const terminalCases = [
    {
      currentStep: ORDER_PROGRESS_STATES.COMPLETED,
      status: "paid",
    },
    {
      currentStep: ORDER_PROGRESS_STATES.FAILED,
      status: "failed",
    },
    {
      currentStep: ORDER_PROGRESS_STATES.CANCELED,
      status: "canceled",
    },
    {
      currentStep: ORDER_PROGRESS_STATES.MANUAL_REVIEW,
      status: "under_review",
    },
    {
      currentStep: "paid",
      status: "paid",
    },
  ];

  for (const [index, terminalCase] of terminalCases.entries()) {
    await createOrder(db, {
      tenantId: "alpha",
      orderId: `order_terminal_${index}`,
      userId: `telegram_terminal_${index}`,
      channel: "telegram",
      productType: "depix",
      currentStep: terminalCase.currentStep,
      status: terminalCase.status,
    });
  }

  await createOrder(db, {
    tenantId: "alpha",
    orderId: "order_open_001",
    userId: "telegram_user_002",
    channel: "telegram",
    productType: "depix",
    currentStep: "draft",
    status: "draft",
  });

  const latestOpenOrder = await getLatestOpenOrderByUser(db, "alpha", "telegram_user_002");
  const missingTenantOrder = await getLatestOpenOrderByUser(db, "beta", "telegram_user_002");
  const terminalLookups = await Promise.all(terminalCases.map((_, index) => getLatestOpenOrderByUser(db, "alpha", `telegram_terminal_${index}`)));

  expect(latestOpenOrder?.orderId).toBe("order_open_001");
  expect(latestOpenOrder?.currentStep).toBe("draft");
  expect(missingTenantOrder).toBeNull();
  expect(terminalLookups).toEqual(terminalCases.map(() => null));
}

async function assertLatestOrderLookupIncludesTerminalRowsForReadOnlyStatus() {
  await resetDatabaseSchema();

  const db = getDatabase(env);

  await createOrder(db, {
    tenantId: "alpha",
    orderId: "order_latest_terminal_001",
    userId: "telegram_user_latest_terminal",
    channel: "telegram",
    productType: "depix",
    currentStep: ORDER_PROGRESS_STATES.MANUAL_REVIEW,
    status: "under_review",
  });
  await createOrder(db, {
    tenantId: "beta",
    orderId: "order_latest_other_tenant",
    userId: "telegram_user_latest_terminal",
    channel: "telegram",
    productType: "depix",
    currentStep: ORDER_PROGRESS_STATES.AMOUNT,
    status: "draft",
  });

  const latestOrder = await getLatestOrderByUser(db, "alpha", "telegram_user_latest_terminal");
  const openOrder = await getLatestOpenOrderByUser(db, "alpha", "telegram_user_latest_terminal");
  const otherTenantOrder = await getLatestOrderByUser(db, "beta", "telegram_user_latest_terminal");

  expect(openOrder).toBeNull();
  expect(latestOrder?.orderId).toBe("order_latest_terminal_001");
  expect(latestOrder?.currentStep).toBe(ORDER_PROGRESS_STATES.MANUAL_REVIEW);
  expect(otherTenantOrder?.orderId).toBe("order_latest_other_tenant");
}

async function assertTelegramChatHydrationContract() {
  await resetDatabaseSchema();

  const db = getDatabase(env);

  await createOrder(db, {
    tenantId: "alpha",
    orderId: "order_chat_legacy",
    userId: "telegram_user_chat_001",
    channel: "telegram",
    productType: "depix",
    currentStep: "amount",
    status: "draft",
  });

  const hydrated = await hydrateOrderTelegramChatIdIfMissing(db, {
    tenantId: "alpha",
    orderId: "order_chat_legacy",
    userId: "telegram_user_chat_001",
    channel: "telegram",
    telegramChatId: "chat-001",
  });
  const replay = await hydrateOrderTelegramChatIdIfMissing(db, {
    tenantId: "alpha",
    orderId: "order_chat_legacy",
    userId: "telegram_user_chat_001",
    channel: "telegram",
    telegramChatId: "chat-001",
  });
  const wrongTenant = await hydrateOrderTelegramChatIdIfMissing(db, {
    tenantId: "beta",
    orderId: "order_chat_legacy",
    userId: "telegram_user_chat_001",
    channel: "telegram",
    telegramChatId: "chat-beta",
  });
  const wrongUser = await hydrateOrderTelegramChatIdIfMissing(db, {
    tenantId: "alpha",
    orderId: "order_chat_legacy",
    userId: "other_user",
    channel: "telegram",
    telegramChatId: "chat-other",
  });
  const savedOrder = await getOrderById(db, "alpha", "order_chat_legacy");

  expect(hydrated.didUpdate).toBe(true);
  expect(hydrated.notFound).toBe(false);
  expect(hydrated.reason).toBe("updated");
  expect(hydrated.order?.telegramChatId).toBe("chat-001");
  expect(replay.didUpdate).toBe(false);
  expect(replay.notFound).toBe(false);
  expect(replay.reason).toBe("already_bound_or_identity_mismatch");
  expect(replay.order?.telegramChatId).toBe("chat-001");
  expect(wrongTenant.notFound).toBe(true);
  expect(wrongTenant.order).toBeNull();
  expect(wrongUser.didUpdate).toBe(false);
  expect(wrongUser.order?.telegramChatId).toBe("chat-001");
  expect(savedOrder?.telegramChatId).toBe("chat-001");
}

describe("database repositories", () => {
  it("persists orders, deposits and deposit events with tenant isolation", assertPersistenceFlow);
  it("migrates legacy deposit_id data into depositEntryId and qrId without orphaning rows", assertLegacyMigrationBackfill);
  it("applies XState order patches with current_step stale-write protection", assertGuardedOrderTransitionWrite);
  it("finds the latest open order for a tenant user without reviving terminal orders", assertLatestOpenOrderLookup);
  it("finds the latest terminal order only through the read-only latest-order lookup", assertLatestOrderLookupIncludesTerminalRowsForReadOnlyStatus);
  it("hydrates telegram chat only through the selected tenant-scoped order", assertTelegramChatHydrationContract);
});
