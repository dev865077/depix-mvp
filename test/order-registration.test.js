/**
 * Testes focados do service de registro e controle de pedidos Telegram.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getDatabase } from "../src/db/client.js";
import { createOrder, getLatestOpenOrderByUser, getOrderById } from "../src/db/repositories/orders-repository.js";
import { restartTelegramOpenOrderConversation } from "../src/services/order-registration.js";

const ORDER_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS orders (tenant_id TEXT NOT NULL, order_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'telegram', product_type TEXT NOT NULL, amount_in_cents INTEGER, wallet_address TEXT, current_step TEXT NOT NULL DEFAULT 'draft', status TEXT NOT NULL DEFAULT 'draft', split_address TEXT, split_fee TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS orders_tenant_id_idx ON orders (tenant_id)",
  "CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id)",
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
