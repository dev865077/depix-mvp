/**
 * Testes do webhook principal de deposito da Eulen.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { getDatabase } from "../src/db/client.js";
import { listDepositEventsByDepositId } from "../src/db/repositories/deposit-events-repository.js";
import { createDeposit, getDepositById } from "../src/db/repositories/deposits-repository.js";
import { createOrder, getOrderById } from "../src/db/repositories/orders-repository.js";
import { resetDatabaseSchema } from "./db.repositories.test.js";

const TENANT_REGISTRY = JSON.stringify({
  alpha: {
    displayName: "Alpha",
    eulenPartnerId: "partner-alpha",
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
    secretBindings: {
      telegramBotToken: "BETA_TELEGRAM_BOT_TOKEN",
      telegramWebhookSecret: "BETA_TELEGRAM_WEBHOOK_SECRET",
      eulenApiToken: "BETA_EULEN_API_TOKEN",
      eulenWebhookSecret: "BETA_EULEN_WEBHOOK_SECRET",
    },
  },
});

function createWorkerEnv() {
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
    BETA_TELEGRAM_BOT_TOKEN: "beta-bot-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
  };
}

async function seedDepositAggregate() {
  await resetDatabaseSchema();

  const db = getDatabase(env);

  await createOrder(db, {
    tenantId: "alpha",
    orderId: "order_alpha_001",
    userId: "telegram_alpha_001",
    channel: "telegram",
    productType: "depix",
    amountInCents: 12345,
    walletAddress: "depix_wallet_alpha",
    currentStep: "awaiting_payment",
    status: "pending",
    splitAddress: "split_wallet_alpha",
    splitFee: "0.50",
  });

  await createDeposit(db, {
    tenantId: "alpha",
    depositId: "qr_alpha_001",
    orderId: "order_alpha_001",
    nonce: "nonce_alpha_001",
    qrCopyPaste: "0002010102122688qr-alpha-001",
    qrImageUrl: "https://example.com/qr/alpha.png",
    externalStatus: "pending",
    expiration: "2026-04-18T04:00:00Z",
  });
}

async function requestEulenWebhook(options = {}) {
  const app = createApp();
  const payload = options.payload ?? {
    webhookType: "deposit",
    qrId: "qr_alpha_001",
    status: "depix_sent",
    bankTxId: "bank_tx_alpha_001",
    blockchainTxID: "blockchain_tx_alpha_001",
  };

  return app.request(
    "https://example.com/webhooks/eulen/alpha/deposit",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.authorizationHeader ? { authorization: options.authorizationHeader } : {}),
      },
      body: JSON.stringify(payload),
    },
    createWorkerEnv(),
  );
}

describe("eulen deposit webhook", () => {
  it("processes a valid webhook and applies payment truth", async function assertValidWebhookProcessing() {
    await seedDepositAggregate();

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
    });
    const body = await response.json();
    const db = getDatabase(env);
    const updatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const updatedDeposit = await getDepositById(db, "alpha", "qr_alpha_001");
    const savedEvents = await listDepositEventsByDepositId(db, "alpha", "qr_alpha_001");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tenantId).toBe("alpha");
    expect(body.externalStatus).toBe("depix_sent");
    expect(updatedOrder?.status).toBe("paid");
    expect(updatedOrder?.currentStep).toBe("completed");
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]?.bankTxId).toBe("bank_tx_alpha_001");
  });

  it("rejects an invalid webhook secret at the boundary", async function assertInvalidSecretRejection() {
    await seedDepositAggregate();

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic wrong-secret",
    });
    const body = await response.json();
    const db = getDatabase(env);
    const savedEvents = await listDepositEventsByDepositId(db, "alpha", "qr_alpha_001");

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("invalid_webhook_secret");
    expect(savedEvents).toHaveLength(0);
  });

  it("ignores repeated delivery without duplicating persistence", async function assertWebhookIdempotency() {
    await seedDepositAggregate();

    const firstResponse = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
    });
    const secondResponse = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
    });
    const secondBody = await secondResponse.json();
    const savedEvents = await listDepositEventsByDepositId(getDatabase(env), "alpha", "qr_alpha_001");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondBody.duplicate).toBe(true);
    expect(savedEvents).toHaveLength(1);
  });

  it("fails explicitly on tenant mismatch signaled by partnerId", async function assertTenantMismatchHandling() {
    await seedDepositAggregate();

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
      payload: {
        webhookType: "deposit",
        qrId: "qr_alpha_001",
        status: "depix_sent",
        partnerId: "partner-gamma",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("tenant_mismatch");
  });
});
