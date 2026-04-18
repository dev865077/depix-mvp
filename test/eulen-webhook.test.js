/**
 * Testes do webhook principal de deposito da Eulen.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { getDatabase } from "../src/db/client.js";
import { createDepositEvent, listDepositEventsByDepositEntryId } from "../src/db/repositories/deposit-events-repository.js";
import {
  createDeposit,
  getDepositByDepositEntryId,
  getDepositByQrId,
  updateDepositByDepositEntryId,
} from "../src/db/repositories/deposits-repository.js";
import { createOrder, getOrderById, updateOrderById } from "../src/db/repositories/orders-repository.js";
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
    ALPHA_DEPIX_SPLIT_ADDRESS: "split-address-alpha",
    ALPHA_DEPIX_SPLIT_FEE: "12.50%",
    BETA_TELEGRAM_BOT_TOKEN: "beta-bot-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
    BETA_DEPIX_SPLIT_ADDRESS: "split-address-beta",
    BETA_DEPIX_SPLIT_FEE: "15.00%",
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
    depositEntryId: "deposit_entry_alpha_001",
    qrId: "qr_alpha_001",
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

afterEach(function restoreWebhookMocks() {
  vi.restoreAllMocks();
});

describe("eulen deposit webhook", () => {
  it("processes a valid webhook and applies payment truth", async function assertValidWebhookProcessing() {
    await seedDepositAggregate();

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
    });
    const body = await response.json();
    const db = getDatabase(env);
    const updatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const updatedDeposit = await getDepositByQrId(db, "alpha", "qr_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tenantId).toBe("alpha");
    expect(body.depositEntryId).toBe("deposit_entry_alpha_001");
    expect(body.qrId).toBe("qr_alpha_001");
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
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

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
    const savedEvents = await listDepositEventsByDepositEntryId(getDatabase(env), "alpha", "deposit_entry_alpha_001");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondBody.duplicate).toBe(true);
    expect(savedEvents).toHaveLength(1);
  });

  it("repairs aggregate state when the latest duplicate event is retried", async function assertDuplicateRepair() {
    await seedDepositAggregate();

    const db = getDatabase(env);
    const payload = {
      webhookType: "deposit",
      qrId: "qr_alpha_001",
      status: "depix_sent",
      bankTxId: "bank_tx_alpha_001",
      blockchainTxID: "blockchain_tx_alpha_001",
    };

    await createDepositEvent(db, {
      tenantId: "alpha",
      orderId: "order_alpha_001",
      depositEntryId: "deposit_entry_alpha_001",
      qrId: "qr_alpha_001",
      source: "webhook",
      externalStatus: "depix_sent",
      bankTxId: "bank_tx_alpha_001",
      blockchainTxId: "blockchain_tx_alpha_001",
      rawPayload: JSON.stringify(payload),
    });

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
      payload,
    });
    const body = await response.json();
    const repairedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const repairedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(body.repairedAggregate).toBe(true);
    expect(repairedOrder?.status).toBe("paid");
    expect(repairedOrder?.currentStep).toBe("completed");
    expect(repairedDeposit?.externalStatus).toBe("depix_sent");
    expect(savedEvents).toHaveLength(1);
  });

  it("does not regress state when an older duplicate event is retried", async function assertOlderDuplicateSafety() {
    await seedDepositAggregate();

    const db = getDatabase(env);
    const olderPayload = {
      webhookType: "deposit",
      qrId: "qr_alpha_001",
      status: "pending",
      bankTxId: "bank_tx_alpha_001",
    };
    const latestPayload = {
      webhookType: "deposit",
      qrId: "qr_alpha_001",
      status: "depix_sent",
      bankTxId: "bank_tx_alpha_001",
      blockchainTxID: "blockchain_tx_alpha_001",
    };

    await createDepositEvent(db, {
      tenantId: "alpha",
      orderId: "order_alpha_001",
      depositEntryId: "deposit_entry_alpha_001",
      qrId: "qr_alpha_001",
      source: "webhook",
      externalStatus: "pending",
      bankTxId: "bank_tx_alpha_001",
      blockchainTxId: null,
      rawPayload: JSON.stringify(olderPayload),
    });
    await createDepositEvent(db, {
      tenantId: "alpha",
      orderId: "order_alpha_001",
      depositEntryId: "deposit_entry_alpha_001",
      qrId: "qr_alpha_001",
      source: "webhook",
      externalStatus: "depix_sent",
      bankTxId: "bank_tx_alpha_001",
      blockchainTxId: "blockchain_tx_alpha_001",
      rawPayload: JSON.stringify(latestPayload),
    });
    await updateDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001", {
      externalStatus: "depix_sent",
    });
    await updateOrderById(db, "alpha", "order_alpha_001", {
      status: "paid",
      currentStep: "completed",
    });

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
      payload: olderPayload,
    });
    const body = await response.json();
    const currentOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const currentDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(body.repairedAggregate).toBe(false);
    expect(currentOrder?.status).toBe("paid");
    expect(currentOrder?.currentStep).toBe("completed");
    expect(currentDeposit?.externalStatus).toBe("depix_sent");
    expect(savedEvents).toHaveLength(2);
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

  it("hydrates qrId from deposit-status before applying webhook truth", async function assertWebhookQrHydration() {
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
      depositEntryId: "deposit_entry_alpha_001",
      qrId: null,
      orderId: "order_alpha_001",
      nonce: "nonce_alpha_001",
      qrCopyPaste: "0002010102122688qr-alpha-001",
      qrImageUrl: "https://example.com/qr/alpha.png",
      externalStatus: "pending",
      expiration: "2026-04-18T04:00:00Z",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        qrId: "qr_alpha_001",
        status: "pending",
        expiration: "2026-04-18T04:00:00Z",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
    });
    const body = await response.json();
    const hydratedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.qrId).toBe("qr_alpha_001");
    expect(hydratedDeposit?.qrId).toBe("qr_alpha_001");
    expect(hydratedDeposit?.externalStatus).toBe("depix_sent");
  });
});
