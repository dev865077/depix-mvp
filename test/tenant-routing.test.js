/**
 * Testes da fundacao multi-tenant do Worker.
 */
// @vitest-pool cloudflare
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  resolveTenantFromRequest,
  TenantRegistryValidationError,
} from "../src/config/tenants.js";
import { resetDatabaseSchema } from "./helpers/database-schema.js";
import { createTenantRegistryKv } from "./helpers/tenant-registry-kv.js";

async function fetchJson(url, init = {}) {
  await env.TENANT_REGISTRY_KV.put("TENANT_REGISTRY", createTenantRegistry());

  const response = await SELF.fetch(url, { method: "POST", ...init });
  const body = await response.json();

  return { response, body };
}

function createTenantRegistry() {
  return JSON.stringify({
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
}

function createTelegramUpdate() {
  return {
    update_id: 10000,
    inline_query: {
      id: "inline-1",
      from: {
        id: 7,
        is_bot: false,
        first_name: "Tester",
      },
      query: "noop",
      offset: "",
    },
  };
}

function createWorkerEnv() {
  return {
    DB: env.DB,
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    EULEN_API_BASE_URL: "https://depix.eulen.app/api",
    EULEN_API_TIMEOUT_MS: "10000",
    TENANT_REGISTRY_KV: createTenantRegistryKv(createTenantRegistry()),
    ALPHA_TELEGRAM_BOT_TOKEN: "123456:alpha-test-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: "split-address-alpha",
    ALPHA_DEPIX_SPLIT_FEE: "12.50%",
    BETA_TELEGRAM_BOT_TOKEN: "123456:beta-test-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
    BETA_DEPIX_SPLIT_ADDRESS: "split-address-beta",
    BETA_DEPIX_SPLIT_FEE: "15.00%",
  };
}

describe("tenant routing", () => {
  it("routes Telegram webhook traffic into the grammY runtime", async function assertTelegramTenantRouting() {
    const app = createApp();
    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: JSON.stringify(createTelegramUpdate()),
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.text()).toBe("");
  });

  it("resolves tenant on eulen webhook path", async function assertEulenTenantRouting() {
    await resetDatabaseSchema();

    const app = createApp();
    const response = await app.request(
      "https://example.com/webhooks/eulen/beta/deposit",
      {
        method: "POST",
        headers: {
          authorization: "Basic beta-eulen-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          webhookType: "deposit",
          qrId: "missing-deposit",
          status: "pending",
        }),
      },
      createWorkerEnv(),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.tenantId).toBe("beta");
    expect(body.error.code).toBe("deposit_not_found");
  });

  it("fails safely when the tenant does not exist", async function assertUnknownTenantFailure() {
    const { response, body } = await fetchJson("https://example.com/telegram/gamma/webhook");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("request_failed");
    expect(body.error.message).toContain("Unknown tenant: gamma");
  });

  it("keeps direct tenant lookup behavior for valid normalized config", function assertValidTenantLookup() {
    const runtimeConfig = {
      tenants: {
        alpha: {
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
      },
    };

    expect(
      resolveTenantFromRequest(runtimeConfig, "/telegram/alpha/webhook"),
    ).toMatchObject({
      tenantId: "alpha",
      displayName: "Alpha",
    });
  });

  it("revalidates malformed tenant config during lookup with the canonical error", function assertLookupStageValidation() {
    const runtimeConfig = {
      tenants: {
        alpha: {
          tenantId: "alpha",
          displayName: "Alpha",
          splitConfigBindings: {
            depixSplitAddress: "ALPHA_DEPIX_SPLIT_ADDRESS",
            splitFee: "",
          },
          opsBindings: {},
          secretBindings: {
            telegramBotToken: "ALPHA_TELEGRAM_BOT_TOKEN",
            telegramWebhookSecret: "ALPHA_TELEGRAM_WEBHOOK_SECRET",
            eulenApiToken: "ALPHA_EULEN_API_TOKEN",
            eulenWebhookSecret: "ALPHA_EULEN_WEBHOOK_SECRET",
          },
        },
      },
    };

    expect(() => {
      resolveTenantFromRequest(runtimeConfig, "/telegram/alpha/webhook");
    }).toThrow(TenantRegistryValidationError);

    try {
      resolveTenantFromRequest(runtimeConfig, "/telegram/alpha/webhook");
    } catch (error) {
      expect(error.toJSON()).toEqual({
        code: "invalid_tenant_registry",
        tenantId: "alpha",
        field: "TENANT_REGISTRY.alpha.splitConfigBindings.splitFee",
        reason: "empty_binding_name",
        stage: "tenant_lookup",
      });
    }
  });

  it("does not convert missing tenants into registry validation errors", function assertUnknownTenantIsNotRegistryInvalid() {
    const runtimeConfig = { tenants: {} };

    expect(resolveTenantFromRequest(runtimeConfig, "/telegram/gamma/webhook")).toBeUndefined();
  });
});
