import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmTelegramPaymentWithBoundary,
  FinancialApiBoundaryError,
  reconcileTelegramPaymentWithBoundary,
} from "../src/services/internal-financial-api.js";

const baseOrder = {
  tenantId: "alpha",
  orderId: "order_alpha_001",
  correlationId: "corr_alpha_001",
  userId: "telegram_user_1",
  channel: "telegram",
  productType: "depix",
  telegramChatId: "123",
  telegramCanonicalMessageId: null,
  telegramCanonicalMessageKind: null,
  amountInCents: 12345,
  walletAddress: "depix_wallet_alpha",
  currentStep: "confirmation",
  status: "processing",
  splitAddress: null,
  splitFee: null,
  createdAt: "2026-04-26T00:00:00Z",
  updatedAt: "2026-04-26T00:00:00Z",
} as never;

const baseDeposit = {
  tenantId: "alpha",
  depositEntryId: "deposit_alpha_001",
  qrId: "qr_alpha_001",
  orderId: "order_alpha_001",
  nonce: "nonce_alpha_001",
  createdRequestId: "req_test_001",
  qrCopyPaste: "000201",
  qrImageUrl: "https://example.com/qr.png",
  externalStatus: "pending",
  expiration: "2026-04-26T01:00:00Z",
  createdAt: "2026-04-26T00:00:00Z",
  updatedAt: "2026-04-26T00:00:00Z",
} as never;

const baseInput = {
  env: {
    DEBOT_INTERNAL_API_TOKEN: "service-token",
  } as never,
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
    financialApiBaseUrl: "https://sagui.example.test",
  },
  requestContext: {
    requestId: "req_test_001",
  },
};

function createProjection(overrides = {}) {
  return {
    ok: true,
    tenantId: "alpha",
    orderId: "order_alpha_001",
    correlationId: "corr_alpha_001",
    depositEntryId: "deposit_alpha_001",
    qrId: "qr_alpha_001",
    qrCopyPaste: "000201",
    qrImageUrl: "https://example.com/qr.png",
    externalStatus: "pending",
    orderStatus: "pending",
    orderCurrentStep: "awaiting_payment",
    expiration: "2026-04-26T01:00:00Z",
    duplicate: false,
    source: "payment_create",
    requestId: "req_test_001",
    ...overrides,
  };
}

function mockFinancialApiResponse(body, init = {}) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  }));

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

describe("external financial API boundary", () => {
  afterEach(function restoreMocks() {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a payment through the external financial API without a local fallback", async function assertExternalConfirmation() {
    const fetchMock = mockFinancialApiResponse(createProjection());

    const result = await confirmTelegramPaymentWithBoundary({
      ...baseInput,
      order: baseOrder,
    });

    expect(result.boundarySource).toBe("external_financial_api");
    expect(result.usedFallback).toBe(false);
    expect(result.accepted).toBe(true);
    expect(result.deposit?.depositEntryId).toBe("deposit_alpha_001");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://sagui.example.test/financial-api/v1/tenants/alpha/payments");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "Authorization": "Bearer service-token",
        "Idempotency-Key": "telegram:alpha:order_alpha_001",
        "X-Correlation-Id": "corr_alpha_001",
        "X-Request-Id": "req_test_001",
      }),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({
      orderId: "order_alpha_001",
      correlationId: "corr_alpha_001",
      amountInCents: 12345,
      walletAddress: "depix_wallet_alpha",
      channel: "telegram",
      resumeIfExists: true,
    });
  });

  it("surfaces financial API failures as controlled bot errors and does not call a legacy charge path", async function assertControlledFailure() {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "payment_dependency_unavailable",
        message: "Financial API unavailable.",
        details: {
          upstream: "sagui",
        },
      },
    }), {
      status: 503,
      headers: {
        "content-type": "application/json",
      },
    })));

    await expect(confirmTelegramPaymentWithBoundary({
      ...baseInput,
      order: baseOrder,
    })).rejects.toMatchObject({
      name: "FinancialApiBoundaryError",
      code: "payment_dependency_unavailable",
      status: 503,
    });
  });

  it("reconciles pending payment state through the external financial API", async function assertExternalReconcile() {
    const fetchMock = mockFinancialApiResponse(createProjection({
      source: "payment_reconcile",
      externalStatus: "paid",
      orderStatus: "paid",
      orderCurrentStep: "completed",
    }));

    const result = await reconcileTelegramPaymentWithBoundary({
      ...baseInput,
      order: baseOrder,
      deposit: baseDeposit,
    });

    expect(result.boundarySource).toBe("external_financial_api");
    expect(result.usedFallback).toBe(false);
    expect(result.result?.details).toMatchObject({
      externalStatus: "paid",
      orderCurrentStep: "completed",
      orderStatus: "paid",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://sagui.example.test/financial-api/v1/tenants/alpha/payments/deposit_alpha_001/reconcile",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      orderId: "order_alpha_001",
      reason: "status_poll",
    });
  });

  it("fails closed when the service token binding is missing", async function assertMissingServiceToken() {
    await expect(confirmTelegramPaymentWithBoundary({
      ...baseInput,
      env: {} as never,
      order: baseOrder,
    })).rejects.toBeInstanceOf(Error);
  });

  it("exports the controlled error class used by the Telegram runtime", function assertErrorType() {
    const error = new FinancialApiBoundaryError("financial_api_request_failed", "failed");

    expect(error.userMessage).toContain("Não consegui criar seu Pix agora.");
  });
});
