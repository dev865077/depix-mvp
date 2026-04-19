/**
 * Testes focados do service de registro e controle de pedidos Telegram.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getDatabase } from "../src/db/client.js";
import { createOrder, getLatestOpenOrderByUser, getOrderById } from "../src/db/repositories/orders-repository.js";
import {
  classifyTelegramChatHydrationResult,
  restartTelegramOpenOrderConversation,
  startTelegramOrderConversation,
} from "../src/services/order-registration.js";

const ORDER_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS orders (tenant_id TEXT NOT NULL, order_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'telegram', product_type TEXT NOT NULL, telegram_chat_id TEXT, amount_in_cents INTEGER, wallet_address TEXT, current_step TEXT NOT NULL DEFAULT 'draft', status TEXT NOT NULL DEFAULT 'draft', split_address TEXT, split_fee TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS orders_tenant_id_idx ON orders (tenant_id)",
  "CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id)",
  "CREATE INDEX IF NOT EXISTS orders_tenant_user_channel_chat_idx ON orders (tenant_id, user_id, channel, telegram_chat_id)",
];

/**
 * Garante o schema minimo da tabela `orders` para testes isolados do service.
 *
 * @param {import('@cloudflare/workers-types').D1Database} db Database de teste.
 * @returns {Promise<void>} Promessa resolvida apos o bootstrap minimo.
 */
async function ensureOrderSchema(db) {
  for (const statement of ORDER_SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
}

describe("telegram order registration controls", () => {
  it("classifies concurrent telegram chat hydration outcomes deterministically", function assertChatHydrationClassification() {
    const updatedLegacyOrder = classifyTelegramChatHydrationResult({
      incomingTelegramChatId: "chat-0",
      hydration: {
        didUpdate: true,
        notFound: false,
        order: {
          telegramChatId: "chat-0",
        },
      },
    });
    const concurrentReplay = classifyTelegramChatHydrationResult({
      incomingTelegramChatId: "chat-1",
      hydration: {
        didUpdate: false,
        notFound: false,
        order: {
          telegramChatId: "chat-1",
        },
      },
    });
    const concurrentMismatch = classifyTelegramChatHydrationResult({
      incomingTelegramChatId: "chat-2",
      hydration: {
        didUpdate: false,
        notFound: false,
        order: {
          telegramChatId: "chat-1",
        },
      },
    });
    const transientConflict = classifyTelegramChatHydrationResult({
      incomingTelegramChatId: "chat-3",
      hydration: {
        didUpdate: false,
        notFound: false,
        order: {
          telegramChatId: null,
        },
      },
    });
    const disappearedOrder = classifyTelegramChatHydrationResult({
      incomingTelegramChatId: "chat-4",
      hydration: {
        didUpdate: false,
        notFound: true,
        order: null,
      },
    });

    expect(updatedLegacyOrder.accepted).toBe(true);
    expect(updatedLegacyOrder.blocked).toBe(false);
    expect(updatedLegacyOrder.result).toBe("telegram_chat_hydrated_legacy_order");
    expect(updatedLegacyOrder.persistedTelegramChatId).toBe("chat-0");
    expect(concurrentReplay.accepted).toBe(true);
    expect(concurrentReplay.blocked).toBe(false);
    expect(concurrentReplay.result).toBe("telegram_chat_hydrated_by_concurrent_request");
    expect(concurrentMismatch.accepted).toBe(false);
    expect(concurrentMismatch.blocked).toBe(true);
    expect(concurrentMismatch.result).toBe("telegram_chat_id_mismatch");
    expect(transientConflict.accepted).toBe(false);
    expect(transientConflict.blocked).toBe(true);
    expect(transientConflict.result).toBe("telegram_chat_hydration_conflict");
    expect(disappearedOrder.notFound).toBe(true);
    expect(disappearedOrder.result).toBe("telegram_chat_order_not_found");
  });

  it("hydrates only the latest selected open order with the Telegram chat id", async function assertLatestOpenOrderChatHydration() {
    const db = getDatabase(env);
    await ensureOrderSchema(db);

    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_chat_old",
      userId: "chat-user-001",
      channel: "telegram",
      productType: "depix",
      currentStep: "amount",
      status: "draft",
    });
    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_chat_new",
      userId: "chat-user-001",
      channel: "telegram",
      productType: "depix",
      currentStep: "amount",
      status: "draft",
    });
    await db
      .prepare("UPDATE orders SET updated_at = ? WHERE tenant_id = ? AND order_id = ?")
      .bind("2026-04-19T01:00:00.000Z", "alpha", "order_chat_old")
      .run();
    await db
      .prepare("UPDATE orders SET updated_at = ? WHERE tenant_id = ? AND order_id = ?")
      .bind("2026-04-19T02:00:00.000Z", "alpha", "order_chat_new")
      .run();

    const session = await startTelegramOrderConversation({
      db,
      tenant: {
        tenantId: "alpha",
      },
      telegramUserId: "chat-user-001",
      telegramChatId: "chat-selected",
    });
    const oldOrder = await getOrderById(db, "alpha", "order_chat_old");
    const newOrder = await getOrderById(db, "alpha", "order_chat_new");

    expect(session.order.orderId).toBe("order_chat_new");
    expect(session.chatBinding.result).toBe("telegram_chat_hydrated_legacy_order");
    expect(oldOrder?.telegramChatId).toBeNull();
    expect(newOrder?.telegramChatId).toBe("chat-selected");
  });

  it("preserves large Telegram chat identifiers as text", async function assertLargeChatIdentifierPersistence() {
    const db = getDatabase(env);
    const largeStringChatId = "9007199254740993123";
    await ensureOrderSchema(db);

    const stringSession = await startTelegramOrderConversation({
      db,
      tenant: {
        tenantId: "alpha",
      },
      telegramUserId: "large-chat-user-string",
      telegramChatId: largeStringChatId,
    });
    const numericSession = await startTelegramOrderConversation({
      db,
      tenant: {
        tenantId: "alpha",
      },
      telegramUserId: "large-chat-user-number",
      telegramChatId: 9007199254740992,
    });

    expect(stringSession.order.telegramChatId).toBe(largeStringChatId);
    expect(numericSession.order.telegramChatId).toBe("9007199254740992");
  });

  it("returns a clear recovery shape when restart cancels the old order but the new one cannot be created", async function assertRestartFailureRecoveryShape() {
    const db = getDatabase(env);
    await ensureOrderSchema(db);
    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_restart_failure",
      userId: "restart-user-001",
      channel: "telegram",
      productType: "depix",
      amountInCents: 2500,
      walletAddress: "lq1qqt6tf80s4c8k5n5v88smk40d5cqh6wp63025cwypeemlh3ra84xgfng64m08lv69d9wau62vag5alxyvzv8hq8qqn9sjtr4pd",
      currentStep: "confirmation",
      status: "draft",
    });

    const restartedSession = await restartTelegramOpenOrderConversation(
      {
        db,
        tenant: {
          tenantId: "alpha",
        },
        telegramUserId: "restart-user-001",
      },
      {
        startConversation: async function failAfterCancel() {
          throw new Error("synthetic_restart_failure");
        },
      },
    );
    const canceledOrder = await getOrderById(db, "alpha", "order_restart_failure");
    const currentOpenOrder = await getLatestOpenOrderByUser(db, "alpha", "restart-user-001");

    expect(restartedSession.previousOrder?.orderId).toBe("order_restart_failure");
    expect(restartedSession.order).toBeNull();
    expect(restartedSession.restarted).toBe(false);
    expect(restartedSession.restartFailed).toBe(true);
    expect(restartedSession.restartFailureReason).toBe("synthetic_restart_failure");
    expect(canceledOrder?.currentStep).toBe("canceled");
    expect(canceledOrder?.status).toBe("canceled");
    expect(currentOpenOrder).toBeNull();
  });
});
