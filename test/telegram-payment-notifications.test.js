/**
 * Testes unitarios do service de notificacao pos-pagamento no Telegram.
 */
import { describe, expect, it } from "vitest";

import {
  buildTelegramOrderNotificationMessage,
  classifyTelegramOrderNotification,
  resolveTelegramNotificationKind,
} from "../src/services/telegram-payment-notifications.js";

describe("telegram payment notifications", () => {
  it("classifies depix_sent as a user-visible payment confirmation", function assertPaymentConfirmedKind() {
    expect(resolveTelegramNotificationKind({
      externalStatus: "depix_sent",
      orderStatus: "paid",
      orderCurrentStep: "completed",
    })).toBe("payment_confirmed");
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
