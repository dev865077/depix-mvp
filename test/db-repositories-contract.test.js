/**
 * Evidência focada dos contratos de persistência tipados.
 */
// @vitest-pool cloudflare
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getDatabase } from "../src/db/client.js";
import { createDepositEvent } from "../src/db/repositories/deposit-events-repository.js";
import { createDeposit } from "../src/db/repositories/deposits-repository.js";
import { createOrder, getOrderById, updateOrderById } from "../src/db/repositories/orders-repository.js";

const SCHEMA_STATEMENTS = [
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

  it("keeps deposit event field mapping stable", async function assertDepositEventContract() {
    const db = getDatabase(env);
    await ensureSchema(db);

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
  });
});
