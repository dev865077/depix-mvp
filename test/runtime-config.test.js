/**
 * Testes da leitura de configuracao operacional do Worker.
 *
 * O objetivo aqui e proteger o contrato de rollout: a rota de recheck tem um
 * gate global e overrides tenant-scoped opcionais. Um override quebrado deve
 * aparecer para operadores sem transformar todos os tenants em indisponiveis.
 */
import { describe, expect, it } from "vitest";

import { readRuntimeConfig } from "../src/config/runtime.js";

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

function createRuntimeEnv(overrides = {}) {
  return {
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
    ALPHA_DEPIX_SPLIT_FEE: "1.00%",
    BETA_TELEGRAM_BOT_TOKEN: "beta-bot-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
    BETA_DEPIX_SPLIT_ADDRESS: "split-address-beta",
    BETA_DEPIX_SPLIT_FEE: "1.00%",
    ENABLE_OPS_DEPOSIT_RECHECK: "true",
    ENABLE_OPS_DEPOSITS_FALLBACK: "true",
    OPS_ROUTE_BEARER_TOKEN: "ops-route-token",
    ...overrides,
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

describe("runtime config", () => {
  it("marks deposit recheck ready when enabled with the global bearer token", () => {
    const runtimeConfig = readRuntimeConfig(createRuntimeEnv());

    expect(runtimeConfig.operations.depositRecheck.state).toBe("ready");
    expect(runtimeConfig.operations.depositRecheck.ready).toBe(true);
    expect(runtimeConfig.operations.depositRecheck.tenantOverrides.state).toBe("ready");
    expect(runtimeConfig.operations.depositRecheck.tenantOverrides.invalidCount).toBe(0);
    expect(runtimeConfig.operations.depositsFallback.state).toBe("ready");
    expect(runtimeConfig.operations.depositsFallback.ready).toBe(true);
  });

  it("marks deposit recheck invalid when the feature flag has an unknown value", () => {
    const runtimeConfig = readRuntimeConfig(createRuntimeEnv({
      ENABLE_OPS_DEPOSIT_RECHECK: "sim",
    }));

    expect(runtimeConfig.operations.depositRecheck.state).toBe("invalid_config");
    expect(runtimeConfig.operations.depositRecheck.ready).toBe(false);
  });

  it("keeps deposits fallback disabled unless its explicit flag is enabled", () => {
    const runtimeConfig = readRuntimeConfig(createRuntimeEnv({
      ENABLE_OPS_DEPOSITS_FALLBACK: undefined,
    }));

    expect(runtimeConfig.operations.depositRecheck.state).toBe("ready");
    expect(runtimeConfig.operations.depositRecheck.ready).toBe(true);
    expect(runtimeConfig.operations.depositsFallback.state).toBe("disabled");
    expect(runtimeConfig.operations.depositsFallback.ready).toBe(false);
  });

  it("marks deposits fallback invalid when its feature flag has an unknown value", () => {
    const runtimeConfig = readRuntimeConfig(createRuntimeEnv({
      ENABLE_OPS_DEPOSITS_FALLBACK: "sim",
    }));

    expect(runtimeConfig.operations.depositsFallback.state).toBe("invalid_config");
    expect(runtimeConfig.operations.depositsFallback.ready).toBe(false);
  });

  it("marks deposit recheck missing_secret when the global token is empty", () => {
    const runtimeConfig = readRuntimeConfig(createRuntimeEnv({
      OPS_ROUTE_BEARER_TOKEN: " ",
    }));

    expect(runtimeConfig.operations.depositRecheck.state).toBe("missing_secret");
    expect(runtimeConfig.operations.depositRecheck.ready).toBe(false);
  });

  it("keeps global readiness while marking a missing tenant override as invalid", () => {
    const runtimeConfig = readRuntimeConfig(createRuntimeEnv({
      TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
      ALPHA_OPS_ROUTE_BEARER_TOKEN: undefined,
    }));

    expect(runtimeConfig.operations.depositRecheck.state).toBe("ready");
    expect(runtimeConfig.operations.depositRecheck.ready).toBe(true);
    expect(runtimeConfig.operations.depositRecheck.tenantOverrides.state).toBe("invalid_config");
    expect(runtimeConfig.operations.depositRecheck.tenantOverrides.invalidCount).toBe(1);
  });

  it("keeps deposit recheck ready when a declared tenant token is configured", () => {
    const runtimeConfig = readRuntimeConfig(createRuntimeEnv({
      TENANT_REGISTRY: createTenantScopedAlphaRegistry(),
      ALPHA_OPS_ROUTE_BEARER_TOKEN: "alpha-ops-route-token",
    }));

    expect(runtimeConfig.operations.depositRecheck.state).toBe("ready");
    expect(runtimeConfig.operations.depositRecheck.ready).toBe(true);
    expect(runtimeConfig.operations.depositRecheck.tenantOverrides.state).toBe("ready");
    expect(runtimeConfig.operations.depositRecheck.tenantOverrides.invalidCount).toBe(0);
  });
});
