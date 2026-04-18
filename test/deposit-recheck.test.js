/**
 * Testes do recheck operacional de deposito via `deposit-status`.
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
    qrId: Object.prototype.hasOwnProperty.call(input, "qrId") ? input.qrId : "qr_alpha_001",
    orderId,
    nonce: input.nonce ?? "nonce_alpha_001",
    qrCopyPaste: "0002010102122688qr-alpha-001",
    qrImageUrl: "https://example.com/qr/alpha.png",
    externalStatus: input.externalStatus ?? "pending",
    expiration: input.expiration ?? "2026-04-18T04:00:00Z",
  });

  return { db, tenantId, orderId, depositEntryId };
}

async function requestDepositRecheck(options = {}) {
  const app = createApp();

  return app.request(
    options.url ?? "https://example.com/ops/alpha/recheck/deposit",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(options.body ?? {
        depositEntryId: "deposit_entry_alpha_001",
      }),
    },
    createWorkerEnv(options.envOverrides),
  );
}

afterEach(function restoreRecheckMocks() {
  vi.restoreAllMocks();
});

describe("deposit recheck route", () => {
  it("reconciles deposit-status truth and records a recheck event", async function assertSuccessfulRecheck() {
    const { db } = await seedDepositAggregate();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        response: {
          qrId: "qr_alpha_001",
          status: "depix_sent",
          expiration: "2026-04-18T04:00:00Z",
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const response = await requestDepositRecheck();
    const body = await response.json();
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const updatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);
    expect(body.source).toBe("recheck_deposit_status");
    expect(body.externalStatus).toBe("depix_sent");
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
    expect(updatedOrder?.status).toBe("paid");
    expect(updatedOrder?.currentStep).toBe("completed");
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]?.source).toBe("recheck_deposit_status");
  });

  it("hydrates qrId from deposit-status before applying the reconciled truth", async function assertQrIdHydration() {
    const { db } = await seedDepositAggregate({
      qrId: null,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        qrId: "qr_alpha_001",
        status: "depix_sent",
        expiration: "2026-04-18T04:00:00Z",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const response = await requestDepositRecheck();
    const body = await response.json();
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.qrId).toBe("qr_alpha_001");
    expect(updatedDeposit?.qrId).toBe("qr_alpha_001");
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
  });

  it("treats an identical repeated recheck as duplicate without duplicating event history", async function assertDuplicateRecheckHandling() {
    const { db } = await seedDepositAggregate();

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockDepositStatus() {
      return new Response(JSON.stringify({
        qrId: "qr_alpha_001",
        status: "depix_sent",
        expiration: "2026-04-18T04:00:00Z",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    await requestDepositRecheck();
    const secondResponse = await requestDepositRecheck();
    const secondBody = await secondResponse.json();
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(secondResponse.status).toBe(200);
    expect(secondBody.ok).toBe(true);
    expect(secondBody.duplicate).toBe(true);
    expect(savedEvents).toHaveLength(1);
  });

  it("keeps tenant isolation explicit when the deposit belongs to another tenant", async function assertTenantIsolation() {
    await seedDepositAggregate({
      tenantId: "alpha",
      orderId: "order_alpha_001",
      depositEntryId: "deposit_entry_alpha_001",
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen for cross-tenant miss"));

    const response = await requestDepositRecheck({
      url: "https://example.com/ops/beta/recheck/deposit",
      body: {
        depositEntryId: "deposit_entry_alpha_001",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("deposit_not_found");
  });

  it("maps missing tenant Eulen credentials before attempting upstream reconciliation", async function assertMissingDependencyMapping() {
    await seedDepositAggregate();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen without credentials"));

    const response = await requestDepositRecheck({
      envOverrides: {
        ALPHA_EULEN_API_TOKEN: undefined,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("recheck_dependency_unavailable");
  });
});
