/**
 * Evidência focada dos contratos de persistência tipados.
 */
// @vitest-pool cloudflare
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getDatabase } from "../src/db/client.js";
import { createDepositEvent, listDepositEventsByDepositEntryId } from "../src/db/repositories/deposit-events-repository.js";
import { createDeposit, DepositOrderUniquenessError } from "../src/db/repositories/deposits-repository.js";
import { createOrder, getOrderById, updateOrderById } from "../src/db/repositories/orders-repository.js";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS orders (
    tenant_id TEXT NOT NULL,
    order_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'telegram',
    product_type TEXT NOT NULL,
    telegram_chat_id TEXT,
    telegram_canonical_message_id INTEGER,
    telegram_canonical_message_kind TEXT,
    amount_in_cents INTEGER,
    wallet_address TEXT,
    current_step TEXT NOT NULL DEFAULT 'draft',
    status TEXT NOT NULL DEFAULT 'draft',
    split_address TEXT,
    split_fee TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
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
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  "CREATE UNIQUE INDEX IF NOT EXISTS deposits_nonce_unique_idx ON deposits (nonce);",
  "CREATE UNIQUE INDEX IF NOT EXISTS deposits_tenant_order_unique_idx ON deposits (tenant_id, order_id);",
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
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
];

async function ensureSchema(db) {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.prepare(statement).run();
  }
}

describe("db repository typed contracts", () => {
  it("keeps order defaults and patch filtering stable", async function assertOrderContract() {
    const db = getDatabase(env);
    await ensureSchema(db);

    const createdOrder = await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_contract_001",
      userId: "user_contract_001",
      productType: "depix",
    });

    expect(createdOrder).toMatchObject({
      tenantId: "alpha",
      orderId: "order_contract_001",
      userId: "user_contract_001",
      channel: "telegram",
      productType: "depix",
      telegramChatId: null,
      telegramCanonicalMessageId: null,
      telegramCanonicalMessageKind: null,
      amountInCents: null,
      walletAddress: null,
      currentStep: "draft",
      status: "draft",
      splitAddress: null,
      splitFee: null,
    });

    await updateOrderById(db, "alpha", "order_contract_001", {
      amountInCents: 2500,
      walletAddress: "wallet-contract-001",
      // @ts-expect-error runtime allowlist should ignore unsupported keys.
      unsupportedField: "ignored",
    });

    const updatedOrder = await getOrderById(db, "alpha", "order_contract_001");

    expect(updatedOrder).toMatchObject({
      amountInCents: 2500,
      walletAddress: "wallet-contract-001",
    });
    expect(updatedOrder).not.toHaveProperty("unsupportedField");
  });

  it("keeps deposit defaults and nullable qr mapping stable", async function assertDepositContract() {
    const db = getDatabase(env);
    await ensureSchema(db);

    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_contract_002",
      userId: "user_contract_002",
      productType: "depix",
    });

    const createdDeposit = await createDeposit(db, {
      tenantId: "alpha",
      depositEntryId: "deposit_entry_contract_001",
      qrId: "   ",
      orderId: "order_contract_002",
      nonce: "nonce-contract-001",
      qrCopyPaste: "pix-code-contract-001",
      qrImageUrl: "https://example.com/qr-contract-001.png",
    });

    expect(createdDeposit).toMatchObject({
      tenantId: "alpha",
      depositEntryId: "deposit_entry_contract_001",
      qrId: null,
      orderId: "order_contract_002",
      nonce: "nonce-contract-001",
      qrCopyPaste: "pix-code-contract-001",
      qrImageUrl: "https://example.com/qr-contract-001.png",
      externalStatus: "pending",
      expiration: null,
    });
  });

  it("keeps duplicate deposits on the tenant/order domain error path", async function assertTenantOrderUniquenessContract() {
    const db = getDatabase(env);
    await ensureSchema(db);

    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_contract_duplicate_001",
      userId: "user_contract_duplicate_001",
      productType: "depix",
    });

    const firstDeposit = await createDeposit(db, {
      tenantId: "alpha",
      depositEntryId: "deposit_entry_contract_duplicate_001",
      qrId: "qr_contract_duplicate_001",
      orderId: "order_contract_duplicate_001",
      nonce: "nonce-contract-duplicate-001",
      qrCopyPaste: "pix-code-contract-duplicate-001",
      qrImageUrl: "https://example.com/qr-contract-duplicate-001.png",
    });

    await expect(createDeposit(db, {
      tenantId: "alpha",
      depositEntryId: "deposit_entry_contract_duplicate_002",
      qrId: "qr_contract_duplicate_002",
      orderId: "order_contract_duplicate_001",
      nonce: "nonce-contract-duplicate-002",
      qrCopyPaste: "pix-code-contract-duplicate-002",
      qrImageUrl: "https://example.com/qr-contract-duplicate-002.png",
    })).rejects.toMatchObject({
      code: "deposit_order_already_has_deposit",
      tenantId: "alpha",
      orderId: "order_contract_duplicate_001",
      existingDeposit: expect.objectContaining({
        depositEntryId: firstDeposit?.depositEntryId,
      }),
    });

    const persistedDeposits = await db
      .prepare("SELECT COUNT(*) AS count FROM deposits WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", "order_contract_duplicate_001")
      .first();

    expect(persistedDeposits?.count).toBe(1);
  });

  it("does not convert unrelated unique violations into tenant/order idempotency", async function assertUnrelatedUniquenessContract() {
    const db = getDatabase(env);
    await ensureSchema(db);

    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_contract_unique_nonce_001",
      userId: "user_contract_unique_nonce_001",
      productType: "depix",
    });
    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_contract_unique_nonce_002",
      userId: "user_contract_unique_nonce_002",
      productType: "depix",
    });

    await createDeposit(db, {
      tenantId: "alpha",
      depositEntryId: "deposit_entry_contract_unique_nonce_001",
      qrId: "qr_contract_unique_nonce_001",
      orderId: "order_contract_unique_nonce_001",
      nonce: "nonce-contract-shared",
      qrCopyPaste: "pix-code-contract-unique-nonce-001",
      qrImageUrl: "https://example.com/qr-contract-unique-nonce-001.png",
    });

    let caughtError;
    try {
      await createDeposit(db, {
        tenantId: "alpha",
        depositEntryId: "deposit_entry_contract_unique_nonce_002",
        qrId: "qr_contract_unique_nonce_002",
        orderId: "order_contract_unique_nonce_002",
        nonce: "nonce-contract-shared",
        qrCopyPaste: "pix-code-contract-unique-nonce-002",
        qrImageUrl: "https://example.com/qr-contract-unique-nonce-002.png",
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).not.toBeInstanceOf(DepositOrderUniquenessError);
    expect(String(caughtError?.message ?? caughtError).toLowerCase()).toContain("unique");
  });

  it("preserves legacy JS coercion before persisting repository inputs", async function assertLegacyJsCoercionContract() {
    const db = getDatabase(env);
    await ensureSchema(db);

    const coercedOrder = await createOrder(db, {
      tenantId: true,
      orderId: false,
      userId: 12345,
      productType: false,
      telegramChatId: true,
      amountInCents: 1250,
      walletAddress: false,
      splitAddress: true,
      splitFee: false,
    });

    const coercedDeposit = await createDeposit(db, {
      tenantId: true,
      depositEntryId: true,
      qrId: false,
      orderId: false,
      nonce: true,
      qrCopyPaste: false,
      qrImageUrl: true,
    });

    expect(coercedOrder).toMatchObject({
      tenantId: "true",
      orderId: "false",
      userId: "12345",
      channel: "telegram",
      productType: "false",
      telegramChatId: "true",
      amountInCents: 1250,
      walletAddress: "false",
      currentStep: "draft",
      status: "draft",
      splitAddress: "true",
      splitFee: "false",
    });
    expect(coercedDeposit).toMatchObject({
      tenantId: "true",
      depositEntryId: "true",
      qrId: "false",
      orderId: "false",
      nonce: "true",
      qrCopyPaste: "false",
      qrImageUrl: "true",
      externalStatus: "pending",
      expiration: null,
    });
  });

  it("keeps deposit event field mapping stable", async function assertDepositEventContract() {
    const db = getDatabase(env);
    await ensureSchema(db);

    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_contract_003",
      userId: "user_contract_003",
      productType: "depix",
    });

    const createdEvent = await createDepositEvent(db, {
      tenantId: "alpha",
      orderId: "order_contract_003",
      depositEntryId: "deposit_entry_contract_003",
      qrId: null,
      source: "webhook",
      externalStatus: "paid",
      bankTxId: "bank-contract-003",
      blockchainTxId: null,
      rawPayload: "{\"status\":\"paid\"}",
    });
    const secondEvent = await createDepositEvent(db, {
      tenantId: "alpha",
      orderId: "order_contract_003",
      depositEntryId: "deposit_entry_contract_003",
      qrId: null,
      source: "recheck",
      externalStatus: "depix_sent",
      bankTxId: null,
      blockchainTxId: null,
      rawPayload: "{\"status\":\"depix_sent\"}",
    });
    const listedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_contract_003");

    expect(createdEvent).toMatchObject({
      tenantId: "alpha",
      orderId: "order_contract_003",
      depositEntryId: "deposit_entry_contract_003",
      qrId: null,
      source: "webhook",
      externalStatus: "paid",
      bankTxId: "bank-contract-003",
      blockchainTxId: null,
      rawPayload: "{\"status\":\"paid\"}",
    });
    expect(typeof createdEvent?.id).toBe("number");
    expect(typeof createdEvent?.receivedAt).toBe("string");
    expect(listedEvents).toHaveLength(2);
    expect(listedEvents[0]).toMatchObject({
      id: secondEvent?.id,
      tenantId: "alpha",
      orderId: "order_contract_003",
      depositEntryId: "deposit_entry_contract_003",
      qrId: null,
      source: "recheck",
      externalStatus: "depix_sent",
      bankTxId: null,
      blockchainTxId: null,
      rawPayload: "{\"status\":\"depix_sent\"}",
    });
    expect(listedEvents[1]).toMatchObject({
      id: createdEvent?.id,
      tenantId: "alpha",
      orderId: "order_contract_003",
      depositEntryId: "deposit_entry_contract_003",
      qrId: null,
      source: "webhook",
      externalStatus: "paid",
      bankTxId: "bank-contract-003",
      blockchainTxId: null,
      rawPayload: "{\"status\":\"paid\"}",
    });
  });
});
