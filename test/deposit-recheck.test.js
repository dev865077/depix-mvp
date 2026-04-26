/**
 * Testes do recheck operacional de deposito via `deposit-status`.
 */
// @vitest-pool cloudflare
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { getDatabase } from "../src/db/client.js";
import { listDepositEventsByDepositEntryId } from "../src/db/repositories/deposit-events-repository.js";
import { createDeposit, getDepositByDepositEntryId } from "../src/db/repositories/deposits-repository.js";
import { createOrder, getOrderById } from "../src/db/repositories/orders-repository.js";
import * as telegramRuntimeModule from "../src/telegram/runtime.js";
import { resetDatabaseSchema } from "./helpers/database-schema.js";
import { withTenantRegistryKv } from "./helpers/tenant-registry-kv.js";

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
    FINANCIAL_API_BASE_URL: "https://sagui.example.test",
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
    OPS_ROUTE_BEARER_TOKEN: "ops-route-test-token",
    ...withTenantRegistryKv(overrides, TENANT_REGISTRY),
  };
}

function createTenantScopedAlphaRegistry() {
  return JSON.stringify({
    alpha: {
      displayName: "Alpha",
      eulenPartnerId: "partner-alpha",
      opsBindings: {
        depositRecheckBearerToken: "ALPHA_OPS_ROUTE_BEARER_TOKEN",
      },
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
    telegramChatId: input.telegramChatId ?? `${tenantId}_telegram_chat_001`,
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
  const headers = {
    "content-type": "application/json",
  };

  if (Object.prototype.hasOwnProperty.call(options, "authorizationHeader")) {
    if (options.authorizationHeader) {
      headers.authorization = options.authorizationHeader;
    }
  } else {
    headers.authorization = "Bearer ops-route-test-token";
  }

  const response = await app.request(
    options.url ?? "https://example.com/ops/alpha/recheck/deposit",
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? {
        depositEntryId: "deposit_entry_alpha_001",
      }),
    },
    createWorkerEnv(options.envOverrides),
  );
  const body = await response.text();

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

afterEach(function restoreRecheckMocks() {
  vi.restoreAllMocks();
});

describe("deposit recheck route", () => {
  it("reconciles deposit-status truth and records a recheck event", async function assertSuccessfulRecheck() {
    const { db } = await seedDepositAggregate();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockRecheckAndTelegram(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit-status?id=deposit_entry_alpha_001") {
        return new Response(JSON.stringify({
          response: {
            bankTxId: "fitbank_123",
            blockchainTxID: "liquid_tx_123",
            qrId: "qr_alpha_001",
            status: "depix_sent",
            expiration: "2026-04-18T04:00:00Z",
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url === "https://api.telegram.org/botalpha-bot-token/sendMessage") {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 601,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

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
    expect(savedEvents[0]?.bankTxId).toBe("fitbank_123");
    expect(savedEvents[0]?.blockchainTxId).toBe("liquid_tx_123");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toMatchObject({
      chat_id: "alpha_telegram_chat_001",
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body)).text).toContain("Pagamento confirmado");
  });

  it("keeps deposit recheck successful when the Telegram notification layer throws unexpectedly", async function assertRecheckNotificationFailureIsolation() {
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

    const createBotSpy = vi.fn(() => {
      throw new Error("synthetic telegram runtime failure");
    });

    vi.spyOn(telegramRuntimeModule, "getTelegramRuntime").mockReturnValue({
      createBot: createBotSpy,
    });

    const response = await requestDepositRecheck();
    const body = await response.json();
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const updatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
    expect(updatedOrder?.status).toBe("paid");
    expect(updatedOrder?.currentStep).toBe("completed");
    expect(savedEvents).toHaveLength(1);
    expect(createBotSpy).toHaveBeenCalledTimes(1);
  });

  it("hydrates qrId from deposit-status before applying the reconciled truth", async function assertQrIdHydration() {
    const { db } = await seedDepositAggregate({
      qrId: null,
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockDepositStatus(input) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit-status?id=deposit_entry_alpha_001") {
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
      }

      if (url === "https://api.telegram.org/botalpha-bot-token/sendMessage") {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 602,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

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

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockDepositStatus(input) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit-status?id=deposit_entry_alpha_001") {
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
      }

      if (url === "https://api.telegram.org/botalpha-bot-token/sendMessage") {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 603,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
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

  it("records the audit event even when the aggregate patch is a no-op", async function assertNoOpAggregatePatch() {
    const { db } = await seedDepositAggregate({
      qrId: "qr_alpha_001",
      externalStatus: "pending",
      status: "pending",
      currentStep: "awaiting_payment",
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

    const response = await requestDepositRecheck();
    const body = await response.json();
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const updatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.externalStatus).toBe("pending");
    expect(updatedDeposit?.externalStatus).toBe("pending");
    expect(updatedOrder?.status).toBe("pending");
    expect(updatedOrder?.currentStep).toBe("awaiting_payment");
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]?.source).toBe("recheck_deposit_status");
  });

  it("keeps concurrent identical rechecks idempotent for event history and aggregate state", async function assertConcurrentDuplicateRecheckHandling() {
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

    const [firstResponse, secondResponse] = await Promise.all([
      requestDepositRecheck(),
      requestDepositRecheck(),
    ]);
    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();
    const updatedDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const updatedOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect([firstBody.duplicate, secondBody.duplicate].filter(Boolean)).toHaveLength(1);
    expect(updatedDeposit?.externalStatus).toBe("depix_sent");
    expect(updatedOrder?.status).toBe("paid");
    expect(updatedOrder?.currentStep).toBe("completed");
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

  it("rejects recheck calls without the operator bearer token", async function assertMissingOperatorAuthorization() {
    await seedDepositAggregate();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen without operator auth"));

    const response = await requestDepositRecheck({
      authorizationHeader: undefined,
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("ops_authorization_required");
  });

  it("rejects recheck calls with an invalid operator bearer token", async function assertInvalidOperatorAuthorization() {
    await seedDepositAggregate();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen with invalid operator auth"));

    const response = await requestDepositRecheck({
      authorizationHeader: "Bearer wrong-token",
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ops_authorization_invalid");
  });

  it("disables the route when the recheck feature flag is turned off", async function assertRouteDisabledByFeatureFlag() {
    await seedDepositAggregate();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen when feature flag is disabled"));

    const response = await requestDepositRecheck({
      envOverrides: {
        ENABLE_OPS_DEPOSIT_RECHECK: "false",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ops_route_disabled");
    expect(body.error.details.bindingName).toBe("ENABLE_OPS_DEPOSIT_RECHECK");
  });

  it("keeps the worker up and returns an explicit disabled error when the feature flag value is unknown", async function assertUnknownFeatureFlagIsSafe() {
    await seedDepositAggregate();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen when feature flag is invalid"));

    const response = await requestDepositRecheck({
      envOverrides: {
        ENABLE_OPS_DEPOSIT_RECHECK: "maybe",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ops_route_disabled_invalid_flag");
    expect(body.error.details.bindingName).toBe("ENABLE_OPS_DEPOSIT_RECHECK");
    expect(body.error.details.rawValue).toBe("maybe");
    expect(consoleSpy.mock.calls.some(([entry]) => (
      typeof entry === "string"
      && entry.includes("\"message\":\"config.invalid_boolean_flag\"")
      && entry.includes("\"bindingName\":\"ENABLE_OPS_DEPOSIT_RECHECK\"")
    ))).toBe(true);
  });

  it("disables the route when the operator bearer token binding is absent", async function assertRouteDisabledWithoutSecret() {
    await seedDepositAggregate();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen when route is disabled"));

    const response = await requestDepositRecheck({
      envOverrides: {
        OPS_ROUTE_BEARER_TOKEN: undefined,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ops_route_disabled");
    expect(body.error.details.bindingName).toBe("OPS_ROUTE_BEARER_TOKEN");
  });

  it("prefers tenant-scoped operator tokens over the global fallback token", async function assertTenantScopedOperatorToken() {
    await seedDepositAggregate();

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

    const forbiddenResponse = await requestDepositRecheck({
      authorizationHeader: "Bearer ops-route-test-token",
      envOverrides: {
        TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
        ALPHA_OPS_ROUTE_BEARER_TOKEN: "alpha-ops-token",
      },
    });
    const forbiddenBody = await forbiddenResponse.json();
    const allowedResponse = await requestDepositRecheck({
      authorizationHeader: "Bearer alpha-ops-token",
      envOverrides: {
        TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
        ALPHA_OPS_ROUTE_BEARER_TOKEN: "alpha-ops-token",
      },
    });

    expect(forbiddenResponse.status).toBe(403);
    expect(forbiddenBody.error.code).toBe("ops_authorization_invalid");
    expect(allowedResponse.status).toBe(200);
  });

  it("proves declared tenant-scoped auth rejects the global token before upstream IO", async function assertTenantScopedOverrideRejectsGlobalTokenAtRoute() {
    await seedDepositAggregate();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("global token must not reach Eulen when tenant override exists"),
    );

    const response = await requestDepositRecheck({
      authorizationHeader: "Bearer ops-route-test-token",
      envOverrides: {
        TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
        ALPHA_OPS_ROUTE_BEARER_TOKEN: "alpha-ops-token",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ops_authorization_invalid");
    expect(body.error.details.authScope).toBe("tenant");
    expect(body.error.details.bindingName).toBe("ALPHA_OPS_ROUTE_BEARER_TOKEN");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proves declared tenant-scoped auth accepts the tenant token at the route", async function assertTenantScopedOverrideAcceptsTenantTokenAtRoute() {
    await seedDepositAggregate();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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

    const response = await requestDepositRecheck({
      authorizationHeader: "Bearer alpha-ops-token",
      envOverrides: {
        TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
        ALPHA_OPS_ROUTE_BEARER_TOKEN: "alpha-ops-token",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "https://api.telegram.org/botalpha-bot-token/sendMessage")).toHaveLength(1);
  });

  it("proves sequential retry idempotency at the route without duplicating recheck events", async function assertRouteLevelSequentialRetryIdempotency() {
    const { db } = await seedDepositAggregate();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockDepositStatus(input) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit-status?id=deposit_entry_alpha_001") {
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
      }

      if (url === "https://api.telegram.org/botalpha-bot-token/sendMessage") {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 603,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const firstResponse = await requestDepositRecheck();
    const secondResponse = await requestDepositRecheck();
    const secondBody = await secondResponse.json();
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondBody.duplicate).toBe(true);
    expect(savedEvents).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "https://api.telegram.org/botalpha-bot-token/sendMessage")).toHaveLength(1);
  });

  it("proves route-level terminal aggregates reject regressive remote statuses", async function assertRouteLevelTerminalRegressionProtection() {
    const { db } = await seedDepositAggregate({
      externalStatus: "depix_sent",
      status: "paid",
      currentStep: "completed",
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

    const response = await requestDepositRecheck();
    const body = await response.json();
    const currentDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const currentOrder = await getOrderById(db, "alpha", "order_alpha_001");

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("deposit_status_regression");
    expect(currentDeposit?.externalStatus).toBe("depix_sent");
    expect(currentOrder?.status).toBe("paid");
    expect(currentOrder?.currentStep).toBe("completed");
  });

  it("fails closed when a tenant-scoped operator token binding is declared but invalid", async function assertInvalidTenantScopedOperatorBinding() {
    await seedDepositAggregate();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen with invalid tenant-scoped binding"));

    const response = await requestDepositRecheck({
      authorizationHeader: "Bearer ops-route-test-token",
      envOverrides: {
        TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
        ALPHA_OPS_ROUTE_BEARER_TOKEN: "",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ops_route_disabled");
    expect(body.error.details.bindingName).toBe("ALPHA_OPS_ROUTE_BEARER_TOKEN");
  });

  it("fails closed when a tenant-scoped operator token binding is declared but missing from the environment", async function assertMissingTenantScopedOperatorBinding() {
    await seedDepositAggregate();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not call Eulen with missing tenant-scoped binding"));

    const response = await requestDepositRecheck({
      authorizationHeader: "Bearer ops-route-test-token",
      envOverrides: {
        TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
        ALPHA_OPS_ROUTE_BEARER_TOKEN: undefined,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ops_route_disabled");
    expect(body.error.details.bindingName).toBe("ALPHA_OPS_ROUTE_BEARER_TOKEN");
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const configWarning = consoleSpy.mock.calls.find(([entry]) => (
      typeof entry === "string"
      && entry.includes("\"message\":\"config.deposit_recheck.tenant_override_invalid\"")
    ))?.[0];

    expect(configWarning).toContain("\"state\":\"invalid_config\"");
    expect(configWarning).toContain("\"invalidTenantOverrideCount\":1");
    expect(configWarning).not.toContain("ALPHA_OPS_ROUTE_BEARER_TOKEN");
  });

  it("uses exact tenant binding names from the registry without collapsing similar tenant ids", async function assertExactTenantScopedBindingMapping() {
    await resetDatabaseSchema();

    const collisionRegistry = JSON.stringify({
      "a-b": {
        displayName: "Tenant A-B",
        eulenPartnerId: "partner-ab",
        opsBindings: {
          depositRecheckBearerToken: "OPS_ROUTE_BEARER_TOKEN_A_DASH_B",
        },
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
      a_b: {
        displayName: "Tenant A_B",
        eulenPartnerId: "partner-a_b",
        opsBindings: {
          depositRecheckBearerToken: "OPS_ROUTE_BEARER_TOKEN_A_UNDERSCORE_B",
        },
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
    const db = getDatabase(env);

    await createOrder(db, {
      tenantId: "a-b",
      orderId: "order_ab_001",
      userId: "tenant_ab_user_001",
      channel: "telegram",
      productType: "depix",
      amountInCents: 12345,
      walletAddress: "depix_wallet_ab",
      currentStep: "awaiting_payment",
      status: "pending",
      splitAddress: "split_wallet_ab",
      splitFee: "0.50",
    });

    await createDeposit(db, {
      tenantId: "a-b",
      depositEntryId: "deposit_entry_ab_001",
      qrId: "qr_ab_001",
      orderId: "order_ab_001",
      nonce: "nonce_ab_001",
      qrCopyPaste: "0002010102122688qr-ab-001",
      qrImageUrl: "https://example.com/qr/ab.png",
      externalStatus: "pending",
      expiration: "2026-04-18T04:00:00Z",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        qrId: "qr_ab_001",
        status: "depix_sent",
        expiration: "2026-04-18T04:00:00Z",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const wrongTenantScopedResponse = await requestDepositRecheck({
      url: "https://example.com/ops/a-b/recheck/deposit",
      authorizationHeader: "Bearer underscore-token",
      body: {
        depositEntryId: "deposit_entry_ab_001",
      },
      envOverrides: {
        TENANT_REGISTRY: collisionRegistry,
        OPS_ROUTE_BEARER_TOKEN_A_DASH_B: "dash-token",
        OPS_ROUTE_BEARER_TOKEN_A_UNDERSCORE_B: "underscore-token",
      },
    });
    const wrongTenantScopedBody = await wrongTenantScopedResponse.json();
    const correctTenantScopedResponse = await requestDepositRecheck({
      url: "https://example.com/ops/a-b/recheck/deposit",
      authorizationHeader: "Bearer dash-token",
      body: {
        depositEntryId: "deposit_entry_ab_001",
      },
      envOverrides: {
        TENANT_REGISTRY: collisionRegistry,
        OPS_ROUTE_BEARER_TOKEN_A_DASH_B: "dash-token",
        OPS_ROUTE_BEARER_TOKEN_A_UNDERSCORE_B: "underscore-token",
      },
    });

    expect(wrongTenantScopedResponse.status).toBe(403);
    expect(wrongTenantScopedBody.error.details.bindingName).toBe("OPS_ROUTE_BEARER_TOKEN_A_DASH_B");
    expect(correctTenantScopedResponse.status).toBe(200);
  });

  it("fails explicitly when deposit-status points to a qrId already owned by another deposit", async function assertQrIdConflict() {
    const { db } = await seedDepositAggregate({
      qrId: null,
    });

    await createOrder(db, {
      tenantId: "alpha",
      orderId: "order_alpha_002",
      userId: "alpha_telegram_user_002",
      channel: "telegram",
      productType: "depix",
      amountInCents: 999,
      walletAddress: "depix_wallet_alpha_002",
      currentStep: "awaiting_payment",
      status: "pending",
      splitAddress: "split_wallet_alpha_002",
      splitFee: "0.50",
    });

    await createDeposit(db, {
      tenantId: "alpha",
      depositEntryId: "deposit_entry_alpha_002",
      qrId: "qr_alpha_conflict_002",
      orderId: "order_alpha_002",
      nonce: "nonce_alpha_002",
      qrCopyPaste: "0002010102122688qr-alpha-002",
      qrImageUrl: "https://example.com/qr/alpha-002.png",
      externalStatus: "pending",
      expiration: "2026-04-18T05:00:00Z",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        qrId: "qr_alpha_conflict_002",
        status: "pending",
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

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("deposit_qr_id_conflict");
    expect(body.error.details.conflictingDepositEntryId).toBe("deposit_entry_alpha_002");
  });

  it("fails explicitly when deposit-status disagrees with an already correlated qrId", async function assertQrIdMismatch() {
    await seedDepositAggregate({
      qrId: "qr_alpha_local_existing",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        qrId: "qr_alpha_remote_other",
        status: "pending",
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

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("deposit_qr_id_mismatch");
    expect(body.error.details.localQrId).toBe("qr_alpha_local_existing");
    expect(body.error.details.remoteQrId).toBe("qr_alpha_remote_other");
  });

  it("rejects a regressive remote status when the local aggregate is already completed", async function assertCompletedAggregateRegressionProtection() {
    const { db } = await seedDepositAggregate({
      externalStatus: "depix_sent",
      status: "paid",
      currentStep: "completed",
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

    const response = await requestDepositRecheck();
    const body = await response.json();
    const currentDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const currentOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("deposit_status_regression");
    expect(currentDeposit?.externalStatus).toBe("depix_sent");
    expect(currentOrder?.status).toBe("paid");
    expect(currentOrder?.currentStep).toBe("completed");
    expect(savedEvents).toHaveLength(0);
  });

  it("does not persist partial local writes when the atomic batch fails after deposit-status succeeds", async function assertAtomicBatchRollback() {
    const { db } = await seedDepositAggregate();
    const batchSpy = vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("synthetic batch failure"));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
    const currentDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const currentOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("request_failed");
    expect(currentDeposit?.externalStatus).toBe("pending");
    expect(currentOrder?.status).toBe("pending");
    expect(currentOrder?.currentStep).toBe("awaiting_payment");
    expect(savedEvents).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    batchSpy.mockRestore();
  });

  it("logs which auth scope was selected when a tenant-scoped token authorizes the recheck", async function assertTenantScopedAuthorizationLogging() {
    await seedDepositAggregate();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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

    const response = await requestDepositRecheck({
      authorizationHeader: "Bearer alpha-ops-token",
      envOverrides: {
        TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
        ALPHA_OPS_ROUTE_BEARER_TOKEN: "alpha-ops-token",
      },
    });

    expect(response.status).toBe(200);
    expect(consoleSpy.mock.calls.some(([entry]) => (
      typeof entry === "string"
      && entry.includes("\"message\":\"ops.deposit_recheck.authorized\"")
      && entry.includes("\"authScope\":\"tenant\"")
      && entry.includes("\"bindingName\":\"ALPHA_OPS_ROUTE_BEARER_TOKEN\"")
    ))).toBe(true);
  });

  it("fails explicitly when the atomic batch cannot re-read the reconciled aggregate", async function assertMissingAggregateSnapshotAfterBatch() {
    const { db } = await seedDepositAggregate();
    const batchSpy = vi.spyOn(db, "batch").mockResolvedValueOnce([
      { results: [{ id: "event_recheck_001" }] },
      { success: true, results: [] },
      { success: true, results: [] },
      { results: [] },
      { results: [] },
    ]);

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
    const currentDeposit = await getDepositByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");
    const currentOrder = await getOrderById(db, "alpha", "order_alpha_001");
    const savedEvents = await listDepositEventsByDepositEntryId(db, "alpha", "deposit_entry_alpha_001");

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("deposit_recheck_persistence_incomplete");
    expect(body.error.details.mayHaveCommitted).toBe(true);
    expect(body.error.details.safeToRetry).toBe(true);
    expect(currentDeposit?.externalStatus).toBe("pending");
    expect(currentOrder?.status).toBe("pending");
    expect(currentOrder?.currentStep).toBe("awaiting_payment");
    expect(savedEvents).toHaveLength(0);

    batchSpy.mockRestore();
  });
});
