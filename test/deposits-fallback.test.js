/**
 * Testes do fallback operacional por janela via `/deposits`.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { getDatabase } from "../src/db/client.js";
import { listDepositEventsByDepositEntryId } from "../src/db/repositories/deposit-events-repository.js";
import { createDeposit, getDepositByDepositEntryId } from "../src/db/repositories/deposits-repository.js";
import { createOrder, getOrderById } from "../src/db/repositories/orders-repository.js";
import { resetDatabaseSchema } from "./db.repositories.test.js";

const TENANT_REGISTRY = JSON.stringify({
  alpha: {
    displayName: "Alpha",
    eulenPartnerId: "partner-alpha",
    splitConfigBindings: {
      depixSplitAddress: "ALPHA_DEPIX_SPLIT_ADDRESS",
      splitFee: "ALPHA_DEPIX_SPLIT_FEE",
    },
    secretBindings: {
      telegramBotToken: "ALPHA_TELEGRAM_BOT_TOKEN",
      telegramWebhookSecret: "ALPHA_TELEGRAM_WEBHOOK_SECRET",
      eulenApiToken: "ALPHA_EULEN_API_TOKEN",
      eulenWebhookSecret: "ALPHA_EULEN_WEBHOOK_SECRET",
    },
  },
  beta: {
    displayName: "Beta",
    eulenPartnerId: "partner-beta",
    splitConfigBindings: {
      depixSplitAddress: "BETA_DEPIX_SPLIT_ADDRESS",
      splitFee: "BETA_DEPIX_SPLIT_FEE",
    },
    secretBindings: {
      telegramBotToken: "BETA_TELEGRAM_BOT_TOKEN",
      telegramWebhookSecret: "BETA_TELEGRAM_WEBHOOK_SECRET",
      eulenApiToken: "BETA_EULEN_API_TOKEN",
      eulenWebhookSecret: "BETA_EULEN_WEBHOOK_SECRET",
    },
  },
});

function createWorkerEnv(overrides = {}) {
  return {
    DB: env.DB,
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    EULEN_API_BASE_URL: "https://depix.eulen.app/api",
    EULEN_API_TIMEOUT_MS: "10000",
    TENANT_REGISTRY,
    ALPHA_TELEGRAM_BOT_TOKEN: "alpha-bot-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: "split-address-alpha",
    ALPHA_DEPIX_SPLIT_FEE: "12.50%",
    BETA_TELEGRAM_BOT_TOKEN: "beta-bot-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
    BETA_DEPIX_SPLIT_ADDRESS: "split-address-beta",
    BETA_DEPIX_SPLIT_FEE: "15.00%",
    ENABLE_OPS_DEPOSIT_RECHECK: "true",
    ENABLE_OPS_DEPOSITS_FALLBACK: "true",
    OPS_ROUTE_BEARER_TOKEN: "ops-route-test-token",
    ...overrides,
  };
}

async function seedDepositAggregate(input = {}) {
  await resetDatabaseSchema();

  const db = getDatabase(env);
  const tenantId = input.tenantId ?? "alpha";
  const orderId = input.orderId ?? "order_alpha_001";
  const depositEntryId = input.depositEntryId ?? "deposit_entry_alpha_001";

  await createOrder(db, {
    tenantId,
    orderId,
    userId: input.userId ?? `${tenantId}_telegram_user_001`,
    channel: "telegram",
    productType: "depix",
    amountInCents: 12345,
    walletAddress: "depix_wallet_alpha",
    currentStep: input.currentStep ?? "awaiting_payment",
    status: input.status ?? "pending",
    splitAddress: "split_wallet_alpha",
    splitFee: "0.50",
  });

  await createDeposit(db, {
    tenantId,
    depositEntryId,
    qrId: input.qrId ?? "qr_alpha_001",
    orderId,
    nonce: input.nonce ?? "nonce_alpha_001",
    qrCopyPaste: "0002010102122688qr-alpha-001",
    qrImageUrl: "https://example.com/qr/alpha.png",
    externalStatus: input.externalStatus ?? "pending",
    expiration: input.expiration ?? "2026-04-18T04:00:00Z",
  });

  return { db, tenantId, orderId, depositEntryId };
}

function mockDepositsListResponse(rows) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }),
  ));
}

async function requestDepositsFallback(options = {}) {
  const app = createApp();
  const headers = {
    "content-type": "application/json",
    authorization: options.authorizationHeader ?? "Bearer ops-route-test-token",
  };

  return app.request(
    options.url ?? "https://example.com/ops/alpha/reconcile/deposits",
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? {
        start: "2026-04-18T00:00:00Z",
        end: "2026-04-19T00:00:00Z",
        status: "depix_sent",
      }),
    },
    createWorkerEnv(options.envOverrides),
  );
}

afterEach(function restoreFallbackMocks() {
  vi.restoreAllMocks();
});

describe("deposits fallback route", () => {
  it("keeps the deposits-list route disabled unless its own rollout flag is enabled", async function assertDepositsFallbackSeparateFlag() {
    await seedDepositAggregate();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await requestDepositsFallback({
      envOverrides: {
        ENABLE_OPS_DEPOSITS_FALLBACK: "false",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ops_deposits_fallback_disabled");
    expect(body.error.details.bindingName).toBe("ENABLE_OPS_DEPOSITS_FALLBACK");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a controlled JSON error when D1 is unavailable", async function assertDepositsFallbackMissingDatabase() {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await requestDepositsFallback({
      envOverrides: {
        DB: undefined,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("deposits_fallback_database_unavailable");
    expect(body.error.details.databaseConfigured).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed windows before calling Eulen", async function assertDepositsFallbackMalformedWindow() {
    await seedDepositAggregate();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await requestDepositsFallback({
      body: {
        start: "not-a-date",
        end: "2026-04-18T01:00:00Z",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("deposits_fallback_invalid_window");
    expect(body.error.details.field).toBe("start");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-monotonic windows before calling Eulen", async function assertDepositsFallbackReversedWindow() {
    await seedDepositAggregate();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await requestDepositsFallback({
      body: {
        start: "2026-04-19T00:00:00Z",
        end: "2026-04-18T00:00:00Z",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("deposits_fallback_invalid_window");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects broad reconciliation windows before calling Eulen", async function assertDepositsFallbackWindowLimit() {
    await seedDepositAggregate();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await requestDepositsFallback({
      body: {
        start: "2026-04-18T00:00:00Z",
        end: "2026-04-19T00:00:01Z",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("deposits_fallback_window_too_large");
    expect(body.error.details.maxWindowHours).toBe(24);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reconciles a delayed deposit from the deposits list and records the source", async function assertDepositsFallbackReconciliation() {
    const { db, depositEntryId, orderId } = await seedDepositAggregate();
    const fetchSpy = mockDepositsListResponse([
      {
        qrId: "qr_alpha_001",
        status: "depix_sent",
        bankTxId: "bank_tx_001",
      },
    ]);

    const response = await requestDepositsFallback();
    const body = await response.json();
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", depositEntryId);
    const updatedOrder = await getOrderById(db, "alpha", orderId);
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", depositEntryId);

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/deposits?start=2026-04-18T00%3A00%3A00Z");
    expect(String(fetchSpy.mock.calls[0][0])).toContain("end=2026-04-19T00%3A00%3A00Z");
    expect(String(fetchSpy.mock.calls[0][0])).toContain("status=depix_sent");
    expect(body.source).toBe("recheck_deposits_list");
    expect(body.summary).toEqual({
      remoteRows: 1,
      processed: 1,
      duplicate: 0,
      skipped: 0,
      failed: 0,
    });
    expect(body.results[0]).toMatchObject({
      outcome: "processed",
      depositEntryId,
      orderId,
      qrId: "qr_alpha_001",
      status: "depix_sent",
    });
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
    expect(updatedOrder?.status).toBe("paid");
    expect(updatedOrder?.currentStep).toBe("completed");
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]?.source).toBe("recheck_deposits_list");
    expect(savedEvents[0]?.externalStatus).toBe("depix_sent");
    expect(savedEvents[0]?.bankTxId).toBe("bank_tx_001");
    expect(savedEvents[0]?.rawPayload).toContain("2026-04-18T00:00:00Z");
  });

  it("fails closed when Eulen returns more rows than the supported fallback limit", async function assertDepositsFallbackRemoteRowLimit() {
    await seedDepositAggregate();
    mockDepositsListResponse(Array.from({ length: 201 }, (_, index) => ({
      qrId: `qr_alpha_${index}`,
      status: "depix_sent",
    })));

    const response = await requestDepositsFallback();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("deposits_fallback_remote_row_limit_exceeded");
    expect(body.error.details.remoteRows).toBe(201);
    expect(body.error.details.maxRemoteRows).toBe(200);
  });

  it("keeps repeated deposits-list reconciliation idempotent", async function assertDepositsFallbackIdempotency() {
    const { db, depositEntryId } = await seedDepositAggregate();
    mockDepositsListResponse([
      {
        qrId: "qr_alpha_001",
        status: "depix_sent",
        bankTxId: "bank_tx_001",
      },
    ]);

    const firstResponse = await requestDepositsFallback();
    const secondResponse = await requestDepositsFallback();
    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", depositEntryId);

    expect(firstBody.summary.processed).toBe(1);
    expect(secondBody.summary.duplicate).toBe(1);
    expect(secondBody.results[0]).toMatchObject({
      outcome: "duplicate",
      repairedAggregate: false,
    });
    expect(savedEvents).toHaveLength(1);
  });

  it("skips remote deposits that cannot be correlated to a local qrId", async function assertUnknownRemoteDepositSkip() {
    await resetDatabaseSchema();

    mockDepositsListResponse([
      {
        qrId: "qr_missing_local",
        status: "depix_sent",
        bankTxId: "bank_tx_missing",
      },
    ]);

    const response = await requestDepositsFallback();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary).toEqual({
      remoteRows: 1,
      processed: 0,
      duplicate: 0,
      skipped: 1,
      failed: 0,
    });
    expect(body.results[0]).toMatchObject({
      outcome: "skipped",
      reason: "local_deposit_not_found",
      qrId: "qr_missing_local",
    });
  });

  it("does not regress a locally completed aggregate from a stale deposits-list row", async function assertCompletedAggregateRegressionSkip() {
    const { db, depositEntryId, orderId } = await seedDepositAggregate({
      externalStatus: "depix_sent",
      status: "paid",
      currentStep: "completed",
    });
    mockDepositsListResponse([
      {
        qrId: "qr_alpha_001",
        status: "pending",
        bankTxId: "bank_tx_stale",
      },
    ]);

    const response = await requestDepositsFallback({
      body: {
        start: "2026-04-18T00:00:00Z",
        end: "2026-04-19T00:00:00Z",
      },
    });
    const body = await response.json();
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", depositEntryId);
    const updatedOrder = await getOrderById(db, "alpha", orderId);
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", depositEntryId);

    expect(response.status).toBe(200);
    expect(body.summary.skipped).toBe(1);
    expect(body.results[0]).toMatchObject({
      outcome: "skipped",
      reason: "status_regression",
      status: "pending",
    });
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
    expect(updatedOrder?.status).toBe("paid");
    expect(updatedOrder?.currentStep).toBe("completed");
    expect(savedEvents).toHaveLength(0);
  });
});
