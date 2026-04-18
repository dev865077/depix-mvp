/**
 * Smoke test do healthcheck do Worker.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

function createHealthTenantRegistry() {
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

function createHealthEnv(overrides = {}) {
  return {
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    EULEN_API_BASE_URL: "https://depix.eulen.app/api",
    EULEN_API_TIMEOUT_MS: "10000",
    TENANT_REGISTRY: createHealthTenantRegistry(),
    ALPHA_TELEGRAM_BOT_TOKEN: "alpha-bot-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: "split-address-alpha",
    ALPHA_DEPIX_SPLIT_FEE: "1.00%",
    BETA_TELEGRAM_BOT_TOKEN: "beta-bot-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
    BETA_DEPIX_SPLIT_ADDRESS: "split-address-beta",
    BETA_DEPIX_SPLIT_FEE: "1.00%",
    ENABLE_OPS_DEPOSIT_RECHECK: "true",
    OPS_ROUTE_BEARER_TOKEN: "ops-route-token",
    ...overrides,
  };
}

export async function fetchHealthResponse() {
  const response = await SELF.fetch("https://example.com/health");
  const body = await response.json();

  return { response, body };
}

export async function assertHealthResponse() {
  const { response, body } = await fetchHealthResponse();

  expect(response.status).toBe(200);
  expect(body.status).toBe("ok");
  expect(body.environment).toBe("local");
  expect(body.configuration.database.bindingConfigured).toBe(true);
  expect(body.configuration.tenants.alpha.displayName).toBe("Alpha");
  expect(body.configuration.tenants.alpha.tenantId).toBe("alpha");
  expect(body.configuration.tenants.alpha.eulenPartnerConfigured).toBe(true);
  expect(body.configuration.tenants.alpha.splitConfigConfigured).toBe(true);
  expect(body.configuration.tenants.alpha.secretBindingsConfigured).toBe(true);
  expect(typeof body.configuration.tenants.alpha.opsDepositRecheckOverrideConfigured).toBe("boolean");
  expect(body.configuration.tenants.beta.displayName).toBe("Beta");
  expect(body.configuration.tenants.beta.tenantId).toBe("beta");
  expect(body.configuration.tenants.beta.eulenPartnerConfigured).toBe(true);
  expect(body.configuration.tenants.beta.splitConfigConfigured).toBe(true);
  expect(body.configuration.tenants.beta.secretBindingsConfigured).toBe(true);
  expect(body.configuration.tenants.beta.opsDepositRecheckOverrideConfigured).toBe(false);
  expect(body.configuration.tenantSummary.configured).toBe(true);
  expect(body.configuration.tenantSummary.count).toBe(2);
  expect(body.configuration.secrets.registryConfigured).toBe(true);
  expect(body.configuration.secrets.tenantSecretBindingsConfigured).toBe(true);
  expect(body.configuration.operations.depositRecheck.state).toBe("disabled");
  expect(body.configuration.operations.depositRecheck.ready).toBe(false);
  expect(body.configuration.operations.depositRecheck.tenantOverrides.state).toBe("ready");
  expect(body.configuration.operations.depositRecheck.tenantOverrides.invalidCount).toBe(0);
}

describe("health route", () => {
  afterEach(function restoreHealthMocks() {
    vi.restoreAllMocks();
  });

  it("returns the runtime status", assertHealthResponse);

  it("redacts tenant binding names from the public health payload", async function assertTenantInventoryRedaction() {
    const response = await createApp().fetch(
      new Request("https://example.com/health"),
      createHealthEnv(),
    );
    const body = await response.json();
    const serializedBody = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(Object.keys(body.configuration.tenants.alpha).sort()).toEqual([
      "displayName",
      "eulenPartnerConfigured",
      "opsDepositRecheckOverrideConfigured",
      "secretBindingsConfigured",
      "splitConfigConfigured",
      "tenantId",
    ]);
    expect(serializedBody).not.toContain('"secretBindings":');
    expect(serializedBody).not.toContain('"splitConfigBindings":');
    expect(serializedBody).not.toContain('"opsBindings":');
    expect(serializedBody).not.toContain("ALPHA_OPS_ROUTE_BEARER_TOKEN");
    expect(serializedBody).not.toContain("ALPHA_TELEGRAM_BOT_TOKEN");
    expect(serializedBody).not.toContain("ALPHA_DEPIX_SPLIT_ADDRESS");
  });

  it("keeps global readiness when a tenant-scoped override is broken", async function assertTenantOverrideHealthIsolation() {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await createApp().fetch(
      new Request("https://example.com/health"),
      createHealthEnv({
        ALPHA_OPS_ROUTE_BEARER_TOKEN: undefined,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.configuration.operations.depositRecheck.state).toBe("ready");
    expect(body.configuration.operations.depositRecheck.ready).toBe(true);
    expect(body.configuration.operations.depositRecheck.tenantOverrides.state).toBe("invalid_config");
    expect(body.configuration.operations.depositRecheck.tenantOverrides.invalidCount).toBe(1);
    expect(Object.keys(body.configuration.operations.depositRecheck.tenantOverrides).sort()).toEqual([
      "invalidCount",
      "state",
    ]);
    expect(JSON.stringify(body.configuration.operations.depositRecheck.tenantOverrides)).not.toContain("alpha");
    expect(JSON.stringify(body.configuration.operations.depositRecheck.tenantOverrides)).not.toContain(
      "ALPHA_OPS_ROUTE_BEARER_TOKEN",
    );
  });
});
