/**
 * Testes unitarios do service de notificacao pos-pagamento no Telegram.
 */
// @vitest-pool cloudflare
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getDatabase } from "../src/db/client.js";
import { createDeposit } from "../src/db/repositories/deposits-repository.js";
import { createOrder } from "../src/db/repositories/orders-repository.js";

import {
  buildTelegramOrderNotificationMessage,
  classifyTelegramOrderNotification,
  notifyTelegramOrderTransitionSafely,
  resolveTelegramNotificationKind,
} from "../src/services/telegram-payment-notifications.js";
import { resetDatabaseSchema } from "./helpers/database-schema.js";

afterEach(function restoreTelegramPaymentNotificationTestState() {
  vi.restoreAllMocks();
});

async function seedTelegramNotificationOrder() {
  await resetDatabaseSchema();

  const db = getDatabase(env);

  await createOrder(db, {
    tenantId: "alpha",
    orderId: "order_alpha_notification_001",
    userId: "telegram_alpha_notification_001",
    channel: "telegram",
    productType: "depix",
    amountInCents: 12345,
    walletAddress: "depix_wallet_alpha",
    currentStep: "completed",
    status: "paid",
    splitAddress: "split_wallet_alpha",
    splitFee: "0.50",
    telegramChatId: "telegram_chat_alpha_001",
    telegramCanonicalMessageId: 44,
    telegramCanonicalMessageKind: "photo",
  });
  await createDeposit(db, {
    tenantId: "alpha",
    depositEntryId: "deposit_alpha_notification_001",
    orderId: "order_alpha_notification_001",
    nonce: "nonce_alpha_notification_001",
    qrCopyPaste: "0002010102122688pix-alpha-notification-001",
    qrImageUrl: "https://example.com/qr/alpha-notification-001.png",
    externalStatus: "depix_sent",
  });

  return db;
}

const TELEGRAM_NOTIFICATION_TENANT = {
  tenantId: "alpha",
  displayName: "Alpha",
  secretBindings: {
    telegramBotToken: "ALPHA_TELEGRAM_BOT_TOKEN",
  },
};

const TELEGRAM_NOTIFICATION_ENV = {
  ...env,
  ALPHA_TELEGRAM_BOT_TOKEN: "alpha-bot-token",
};

describe("telegram payment notifications", () => {
  it("classifies depix_sent as a user-visible payment confirmation", function assertPaymentConfirmedKind() {
    expect(resolveTelegramNotificationKind({
      externalStatus: "depix_sent",
      orderStatus: "paid",
      orderCurrentStep: "completed",
    })).toBe("payment_confirmed");
  });

  it("returns null for non-payment states in this PR slice", function assertOnlyPaymentConfirmedKindIsExposed() {
    expect(resolveTelegramNotificationKind({
      externalStatus: "under_review",
      orderStatus: "under_review",
      orderCurrentStep: "manual_review",
    })).toBeNull();
  });

  it("skips notification when the visible state did not change", function assertVisibleStateUnchangedSkip() {
    expect(classifyTelegramOrderNotification({
      duplicate: false,
      externalStatus: "depix_sent",
      orderStatus: "paid",
      orderCurrentStep: "completed",
      previousExternalStatus: "depix_sent",
      previousOrderStatus: "pending",
      previousOrderCurrentStep: "awaiting_payment",
      order: {
        channel: "telegram",
        telegramChatId: "chat_001",
      },
    })).toEqual({
      shouldNotify: false,
      reason: "visible_state_unchanged",
      kind: "payment_confirmed",
    });
  });

  it("skips non-payment terminal states in this MVP slice", function assertNonPaymentNotificationOutOfScope() {
    expect(classifyTelegramOrderNotification({
      duplicate: false,
      externalStatus: "under_review",
      orderStatus: "under_review",
      orderCurrentStep: "manual_review",
      previousExternalStatus: "pending",
      previousOrderStatus: "pending",
      previousOrderCurrentStep: "awaiting_payment",
      order: {
        channel: "telegram",
        telegramChatId: "chat_001",
      },
    })).toEqual({
      shouldNotify: false,
      reason: "external_status_not_notifiable",
      kind: null,
    });
  });


  it("returns a structured failure instead of throwing on real Telegram 429 outbound errors", async function assertRealOutboundFailureShape() {
    const db = await seedTelegramNotificationOrder();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry later",
    }), {
      status: 429,
      headers: {
        "content-type": "application/json",
      },
    }));

    await expect(notifyTelegramOrderTransitionSafely({
      env: TELEGRAM_NOTIFICATION_ENV,
      db,
      runtimeConfig: {
        environment: "test",
        appName: "depix-mvp",
      },
      tenant: TELEGRAM_NOTIFICATION_TENANT,
      requestContext: {
        requestId: "test-request-id",
        method: "POST",
        path: "/ops/alpha/reconcile/deposits",
      },
      orderId: "order_alpha_notification_001",
      externalStatus: "depix_sent",
      orderStatus: "paid",
      orderCurrentStep: "completed",
      previousExternalStatus: "pending",
      previousOrderStatus: "pending",
      previousOrderCurrentStep: "awaiting_payment",
    })).resolves.toEqual({
      delivered: false,
      skipped: false,
      failed: true,
      reason: "telegram_outbound_request_failed",
      kind: "payment_confirmed",
    });
  });

  it("builds a payment-confirmed message with amount", function assertPaymentConfirmedMessage() {
    const message = buildTelegramOrderNotificationMessage({
      tenant: {
        displayName: "Alpha",
      },
      order: {
        amountInCents: 12345,
      },
      kind: "payment_confirmed",
    });

    expect(message).toContain("Pagamento confirmado em Alpha.");
    expect(message).toContain("R$");
    expect(message).toContain("concluído");
  });

  it("edits the canonical Telegram order message when payment confirmation arrives", async function assertCanonicalMessageEdit() {
    const db = await seedTelegramNotificationOrder();
    const telegramCalls = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));
      telegramCalls.push({
        url,
        payload,
      });

      return new Response(JSON.stringify({
        ok: true,
        result: true,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const result = await notifyTelegramOrderTransitionSafely({
      env: TELEGRAM_NOTIFICATION_ENV,
      db,
      runtimeConfig: {
        environment: "test",
        appName: "depix-mvp",
      },
      tenant: TELEGRAM_NOTIFICATION_TENANT,
      requestContext: {
        requestId: "test-request-id",
        method: "POST",
        path: "/ops/alpha/reconcile/deposits",
      },
      orderId: "order_alpha_notification_001",
      depositEntryId: "deposit_alpha_notification_001",
      externalStatus: "depix_sent",
      orderStatus: "paid",
      orderCurrentStep: "completed",
      previousExternalStatus: "pending",
      previousOrderStatus: "pending",
      previousOrderCurrentStep: "awaiting_payment",
    });

    expect(result).toEqual({
      delivered: true,
      skipped: false,
      failed: false,
      reason: "delivered",
      kind: "payment_confirmed",
    });
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].url).toContain("/editMessageCaption");
    expect(telegramCalls[0].payload.message_id).toBe(44);
    expect(telegramCalls[0].payload.caption).toContain("Pagamento confirmado em Alpha.");
    expect(telegramCalls[0].payload.caption).toContain("Pix deste pedido:");
    expect(telegramCalls[0].payload.caption).toContain("0002010102122688pix-alpha-notification-001");
  });

  it("treats Telegram no-op edit errors as delivered without fallback duplication", async function assertCanonicalNoopEdit() {
    const db = await seedTelegramNotificationOrder();
    const telegramCalls = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));
      telegramCalls.push({
        url,
        payload,
      });

      if (url.includes("/editMessageCaption")) {
        return new Response(JSON.stringify({
          ok: false,
          description: "Bad Request: message is not modified",
        }), {
          status: 400,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected URL in canonical noop flow: ${url}`);
    });

    const result = await notifyTelegramOrderTransitionSafely({
      env: TELEGRAM_NOTIFICATION_ENV,
      db,
      runtimeConfig: {
        environment: "test",
        appName: "depix-mvp",
      },
      tenant: TELEGRAM_NOTIFICATION_TENANT,
      requestContext: {
        requestId: "test-request-id",
        method: "POST",
        path: "/ops/alpha/reconcile/deposits",
      },
      orderId: "order_alpha_notification_001",
      depositEntryId: "deposit_alpha_notification_001",
      externalStatus: "depix_sent",
      orderStatus: "paid",
      orderCurrentStep: "completed",
      previousExternalStatus: "pending",
      previousOrderStatus: "pending",
      previousOrderCurrentStep: "awaiting_payment",
    });
    const updatedOrder = await getDatabase(env)
      .prepare("SELECT telegram_canonical_message_id AS telegramCanonicalMessageId, telegram_canonical_message_kind AS telegramCanonicalMessageKind FROM orders WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", "order_alpha_notification_001")
      .first();

    expect(result).toEqual({
      delivered: true,
      skipped: false,
      failed: false,
      reason: "delivered",
      kind: "payment_confirmed",
    });
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].url).toContain("/editMessageCaption");
    expect(updatedOrder).toEqual({
      telegramCanonicalMessageId: 44,
      telegramCanonicalMessageKind: "photo",
    });
  });

  it("reanchors the canonical Telegram message when edit fails and fallback send succeeds", async function assertCanonicalFallbackReanchor() {
    const db = await seedTelegramNotificationOrder();
    const telegramCalls = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));
      telegramCalls.push({
        url,
        payload,
      });

      if (url.includes("/editMessageCaption")) {
        return new Response(JSON.stringify({
          ok: false,
          description: "Bad Request: message to edit not found",
        }), {
          status: 400,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendMessage")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 88,
            date: 1713434499,
            text: payload.text,
            chat: {
              id: payload.chat_id,
              type: "private",
            },
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected URL in canonical fallback flow: ${url}`);
    });

    const firstResult = await notifyTelegramOrderTransitionSafely({
      env: TELEGRAM_NOTIFICATION_ENV,
      db,
      runtimeConfig: {
        environment: "test",
        appName: "depix-mvp",
      },
      tenant: TELEGRAM_NOTIFICATION_TENANT,
      requestContext: {
        requestId: "test-request-id",
        method: "POST",
        path: "/ops/alpha/reconcile/deposits",
      },
      orderId: "order_alpha_notification_001",
      depositEntryId: "deposit_alpha_notification_001",
      externalStatus: "depix_sent",
      orderStatus: "paid",
      orderCurrentStep: "completed",
      previousExternalStatus: "pending",
      previousOrderStatus: "pending",
      previousOrderCurrentStep: "awaiting_payment",
    });
    const updatedOrder = await getDatabase(env)
      .prepare("SELECT telegram_canonical_message_id AS telegramCanonicalMessageId, telegram_canonical_message_kind AS telegramCanonicalMessageKind FROM orders WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", "order_alpha_notification_001")
      .first();

    expect(firstResult).toEqual({
      delivered: true,
      skipped: false,
      failed: false,
      reason: "delivered",
      kind: "payment_confirmed",
    });
    expect(telegramCalls[0].url).toContain("/editMessageCaption");
    expect(telegramCalls[1].url).toContain("/sendMessage");
    expect(updatedOrder).toEqual({
      telegramCanonicalMessageId: 88,
      telegramCanonicalMessageKind: "text",
    });

    telegramCalls.length = 0;

    const secondResult = await notifyTelegramOrderTransitionSafely({
      env: TELEGRAM_NOTIFICATION_ENV,
      db,
      runtimeConfig: {
        environment: "test",
        appName: "depix-mvp",
      },
      tenant: TELEGRAM_NOTIFICATION_TENANT,
      requestContext: {
        requestId: "test-request-id-2",
        method: "POST",
        path: "/ops/alpha/reconcile/deposits",
      },
      orderId: "order_alpha_notification_001",
      depositEntryId: "deposit_alpha_notification_001",
      externalStatus: "depix_sent",
      orderStatus: "paid",
      orderCurrentStep: "completed",
      previousExternalStatus: "pending_retry",
      previousOrderStatus: "pending",
      previousOrderCurrentStep: "awaiting_payment",
    });

    expect(secondResult).toEqual({
      delivered: true,
      skipped: false,
      failed: false,
      reason: "delivered",
      kind: "payment_confirmed",
    });
    expect(telegramCalls[0].url).toContain("/editMessageText");
    expect(telegramCalls[0].payload.message_id).toBe(88);
  });
});
