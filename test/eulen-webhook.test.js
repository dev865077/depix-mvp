/**
 * Testes do webhook principal de deposito da Eulen.
 */
// @vitest-pool cloudflare
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
import { reconcileOrderPatch } from "../src/services/eulen-deposit-webhook.js";
import * as telegramRuntimeModule from "../src/telegram/runtime.js";
import { resetDatabaseSchema } from "./helpers/database-schema.js";

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

async function seedDepositAggregate(input = {}) {
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
    telegramChatId: input.telegramChatId ?? "telegram_chat_alpha_001",
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
      body: options.rawBody ?? JSON.stringify(payload),
    },
    createWorkerEnv(),
  );
}

afterEach(function restoreWebhookMocks() {
  vi.restoreAllMocks();
});

describe("eulen deposit webhook", () => {
  it("answers browser probes on the canonical webhook URL without route_not_found", async function assertWebhookProbe() {
    const app = createApp();
    const response = await app.request(
      "https://example.com/webhooks/eulen/alpha/deposit",
      { method: "GET" },
      createWorkerEnv(),
    );
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(body.tenantId).toBe("alpha");
    expect(body.error.code).toBe("webhook_method_not_allowed");
    expect(body.error.message).toContain("expects POST");
    expect(body.error.details).toMatchObject({
      expectedMethod: "POST",
      receivedMethod: "GET",
    });
  });

  it("preserves terminal-safe order fields while protecting terminal currentStep", function assertTerminalSafeOrderPatch() {
    const patch = reconcileOrderPatch(
      {
        status: "paid",
        currentStep: "completed",
      },
      {
        status: "under_review",
        currentStep: "manual_review",
      },
    );

    expect(patch).toEqual({
      status: "under_review",
    });
  });

  it("processes a valid webhook, applies payment truth and notifies Telegram", async function assertValidWebhookProcessing() {
    await seedDepositAggregate();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramNotification(input, init) {
      const url = String(input);

      expect(url).toContain("https://api.telegram.org/botalpha-bot-token/sendMessage");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 501,
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      chat_id: "telegram_chat_alpha_001",
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).text).toContain("Pagamento confirmado");
  });

  it("rolls back deposit and order updates together while preserving the webhook audit event", async function assertWebhookAggregateAtomicity() {
    await seedDepositAggregate();

    const db = getDatabase(env);

    await db.prepare(`
      CREATE TRIGGER fail_order_update_before_update
      BEFORE UPDATE ON orders
      WHEN NEW.order_id = 'order_alpha_001'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic order update failure');
      END;
    `).run();

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
    });
    const currentOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const currentDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(500);
    expect(currentOrder?.status).toBe("pending");
    expect(currentOrder?.currentStep).toBe("awaiting_payment");
    expect(currentDeposit?.externalStatus).toBe("pending");
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]?.externalStatus).toBe("depix_sent");
    expect(savedEvents[0]?.bankTxId).toBe("bank_tx_alpha_001");
  });

  it("keeps webhook reconciliation successful when the Telegram notification layer throws unexpectedly", async function assertWebhookNotificationFailureIsolation() {
    await seedDepositAggregate();

    const createBotSpy = vi.fn(() => {
      throw new Error("synthetic telegram runtime failure");
    });

    vi.spyOn(telegramRuntimeModule, "getTelegramRuntime").mockReturnValue({
      createBot: createBotSpy,
    });

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
    });
    const body = await response.json();
    const db = getDatabase(env);
    const updatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(updatedOrder?.status).toBe("paid");
    expect(updatedOrder?.currentStep).toBe("completed");
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
    expect(savedEvents).toHaveLength(1);
    expect(createBotSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps webhook reconciliation successful when Telegram returns 429", async function assertWebhookTelegram429Isolation() {
    await seedDepositAggregate();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry later",
      }), {
        status: 429,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
    });
    const body = await response.json();
    const db = getDatabase(env);
    const updatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(updatedOrder?.status).toBe("paid");
    expect(updatedOrder?.currentStep).toBe("completed");
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

  it("fails closed with structured details when the webhook JSON is malformed", async function assertMalformedWebhookPayload() {
    await seedDepositAggregate();

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
      rawBody: "{",
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_webhook_payload");
    expect(body.error.details).toMatchObject({
      code: "eulen_invalid_payload",
      source: "webhook",
      reason: "webhook_body_invalid_json",
    });
  });

  it("fails closed with structured details when the webhook misses a required field", async function assertStructuredWebhookFieldValidation() {
    await seedDepositAggregate();

    const response = await requestEulenWebhook({
      authorizationHeader: "Basic alpha-eulen-secret",
      payload: {
        webhookType: "deposit",
        qrId: "qr_alpha_001",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_webhook_payload");
    expect(body.error.details).toMatchObject({
      code: "eulen_invalid_payload",
      source: "webhook",
      reason: "missing_required_string",
      field: "status",
    });
  });

  it("ignores repeated delivery without duplicating persistence or Telegram notification", async function assertWebhookIdempotency() {
    await seedDepositAggregate();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 502,
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

  it("does not mutate unrelated deposits while hydrating an unknown webhook qrId", async function assertUnknownQrIdHydrationIsolation() {
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
        status: "depix_sent",
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
      payload: {
        webhookType: "deposit",
        qrId: "qr_unknown_001",
        status: "depix_sent",
      },
    });
    const body = await response.json();
    const unrelatedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const unrelatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("deposit_not_found");
    expect(unrelatedDeposit?.qrId).toBeNull();
    expect(unrelatedDeposit?.externalStatus).toBe("pending");
    expect(unrelatedOrder?.status).toBe("pending");
    expect(unrelatedOrder?.currentStep).toBe("awaiting_payment");
    expect(savedEvents).toHaveLength(0);
  });

  it("fails closed when deposit-status returns an invalid external contract", async function assertInvalidDepositStatusContract() {
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
        qrId: 123,
        status: "pending",
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

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("deposit_lookup_unavailable");
    expect(body.error.details.cause).toMatchObject({
      code: "eulen_invalid_payload",
      source: "response",
      field: "qrId",
      path: "/deposit-status",
    });
  });

  it("fails explicitly when webhook dependencies are unavailable", async function assertMissingWebhookDependency() {
    await seedDepositAggregate();

    const app = createApp();
    const response = await app.request(
      "https://example.com/webhooks/eulen/alpha/deposit",
      {
        method: "POST",
        headers: {
          authorization: "Basic alpha-eulen-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          webhookType: "deposit",
          qrId: "qr_alpha_001",
          status: "depix_sent",
        }),
      },
      {
        ...createWorkerEnv(),
        ALPHA_EULEN_API_TOKEN: undefined,
      },
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("webhook_dependency_unavailable");
  });

  it("does not hydrate from a deposit-status qrId that differs from the webhook target", async function assertDifferentQrIdHydrationIsolation() {
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
    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_alpha_002",
      userId: "telegram_alpha_002",
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
      qrImageUrl: "https://example.com/qr/alpha-1.png",
      externalStatus: "pending",
      expiration: "2026-04-18T04:00:00Z",
    });
    await createDeposit(db, {
      tenantId: "alpha",
      depositEntryId: "deposit_entry_alpha_002",
      qrId: "qr_conflict_001",
      orderId: "order_alpha_002",
      nonce: "nonce_alpha_002",
      qrCopyPaste: "0002010102122688qr-alpha-002",
      qrImageUrl: "https://example.com/qr/alpha-2.png",
      externalStatus: "pending",
      expiration: "2026-04-18T04:00:00Z",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        qrId: "qr_conflict_001",
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
      payload: {
        webhookType: "deposit",
        qrId: "qr_new_001",
        status: "depix_sent",
      },
    });
    const body = await response.json();
    const unmatchedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const existingDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_002");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("deposit_not_found");
    expect(unmatchedDeposit?.qrId).toBeNull();
    expect(unmatchedDeposit?.externalStatus).toBe("pending");
    expect(existingDeposit?.qrId).toBe("qr_conflict_001");
    expect(existingDeposit?.externalStatus).toBe("pending");
  });
});
