import { describe, expect, it, vi } from "vitest";

import { confirmTelegramPaymentWithBoundary, reconcileTelegramPaymentWithBoundary } from "../src/services/internal-financial-api.js";
import { TelegramOrderConfirmationError } from "../src/services/telegram-order-confirmation.js";

const baseInput = {
  env: {} as never,
  db: {} as D1Database,
  tenant: {
    tenantId: "alpha",
    displayName: "Alpha",
    splitConfigBindings: {
      depixSplitAddress: "ALPHA_DEPIX_SPLIT_ADDRESS",
      splitFee: "ALPHA_DEPIX_SPLIT_FEE",
    },
    opsBindings: {},
    secretBindings: {
      telegramBotToken: "ALPHA_TELEGRAM_BOT_TOKEN",
      telegramWebhookSecret: "ALPHA_TELEGRAM_WEBHOOK_SECRET",
      eulenApiToken: "ALPHA_EULEN_API_TOKEN",
      eulenWebhookSecret: "ALPHA_EULEN_WEBHOOK_SECRET",
    },
  },
  runtimeConfig: {
    appName: "depix-mvp",
    environment: "test",
    logLevel: "debug",
    eulenApiBaseUrl: "https://depix.eulen.app/api",
    eulenApiTimeoutMs: 1000,
  },
  requestContext: {
    requestId: "req_test_001",
  },
};

describe("internal financial API boundary", () => {
  it("falls back to the legacy confirmation path when the boundary wrapper fails unexpectedly", async function assertConfirmationFallback() {
    const confirmationSession = {
      order: {
        orderId: "order_alpha_001",
      },
      deposit: {
        depositEntryId: "deposit_alpha_001",
      },
      accepted: true,
      conflict: false,
      parseResult: null,
    };

    const result = await confirmTelegramPaymentWithBoundary(
      {
        ...baseInput,
        order: {
          orderId: "order_alpha_001",
        } as never,
      },
      {
        confirmThroughBoundary: vi.fn().mockRejectedValue(new Error("boundary exploded")),
        confirmLegacyFallback: vi.fn().mockResolvedValue(confirmationSession),
        reconcileThroughBoundary: vi.fn(),
        reconcileLegacyFallback: vi.fn(),
      },
    );

    expect(result.boundarySource).toBe("legacy_confirmation_path");
    expect(result.usedFallback).toBe(true);
    expect(result.deposit?.depositEntryId).toBe("deposit_alpha_001");
  });

  it("does not mask business confirmation errors behind the legacy fallback", async function assertConfirmationBusinessErrorsPassThrough() {
    await expect(confirmTelegramPaymentWithBoundary(
      {
        ...baseInput,
        order: {
          orderId: "order_alpha_001",
        } as never,
      },
      {
        confirmThroughBoundary: vi.fn().mockRejectedValue(
          new TelegramOrderConfirmationError(
            "telegram_order_confirmation_failed",
            "Business failure",
            "User-facing message",
          ),
        ),
        confirmLegacyFallback: vi.fn(),
        reconcileThroughBoundary: vi.fn(),
        reconcileLegacyFallback: vi.fn(),
      },
    )).rejects.toMatchObject({
      code: "telegram_order_confirmation_failed",
    });
  });

  it("falls back to the legacy recheck path when the boundary recheck wrapper fails", async function assertRecheckFallback() {
    const result = await reconcileTelegramPaymentWithBoundary(
      {
        ...baseInput,
        order: {
          orderId: "order_alpha_001",
        } as never,
        deposit: {
          depositEntryId: "deposit_alpha_001",
        } as never,
      },
      {
        confirmThroughBoundary: vi.fn(),
        confirmLegacyFallback: vi.fn(),
        reconcileThroughBoundary: vi.fn().mockRejectedValue(new Error("recheck boundary exploded")),
        reconcileLegacyFallback: vi.fn().mockResolvedValue({
          order: {
            orderId: "order_alpha_001",
          },
          deposit: {
            depositEntryId: "deposit_alpha_001",
          },
          attempted: true,
          result: null,
          boundarySource: "legacy_recheck_path",
          usedFallback: true,
        }),
      },
    );

    expect(result.boundarySource).toBe("legacy_recheck_path");
    expect(result.usedFallback).toBe(true);
    expect(result.attempted).toBe(true);
  });
});
