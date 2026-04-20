/**
 * Testes unitarios do service de notificacao pos-pagamento no Telegram.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getDatabase } from "../src/db/client.js";
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
});
