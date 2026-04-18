/**
 * Testes do bootstrap do runtime Telegram.
 */
import { Bot } from "grammy";
import { afterEach, describe, expect, it } from "vitest";

import { readTenantRegistry } from "../src/config/tenants.js";
import {
  clearTelegramRuntimeCache,
  getTelegramRuntime,
  listBootstrappedTelegramTenants,
} from "../src/telegram/runtime.js";

const TEST_ENV = {
  TENANT_REGISTRY: JSON.stringify({
    alpha: {
      displayName: "Alpha",
      eulenPartnerId: "partner-alpha",
      splitConfig: {
        depixSplitAddress: "split-address-alpha",
        splitFee: "12.50",
      },
      secretBindings: {
        telegramBotToken: "ALPHA_TELEGRAM_BOT_TOKEN",
        telegramWebhookSecret: "ALPHA_TELEGRAM_WEBHOOK_SECRET",
        eulenApiToken: "ALPHA_EULEN_API_TOKEN",
        eulenWebhookSecret: "ALPHA_EULEN_WEBHOOK_SECRET",
      },
    },
  }),
};

afterEach(function resetTelegramRuntimeCache() {
  clearTelegramRuntimeCache();
});

describe("telegram runtime bootstrap", () => {
  it("bootstraps a grammY runtime for the resolved tenant", function assertTelegramRuntimeBootstrap() {
    const tenants = readTenantRegistry(TEST_ENV);
    const runtime = getTelegramRuntime(tenants.alpha);

    expect(runtime.engine).toBe("grammy");
    expect(runtime.tenantId).toBe("alpha");
    expect(runtime.botInfo.first_name).toBe("Alpha Runtime");
    expect(runtime.botInfo.username).toBe("alpha_bootstrap_bot");
    expect(tenants.alpha.splitConfig.depixSplitAddress).toBe("split-address-alpha");
    expect(listBootstrappedTelegramTenants()).toEqual(["alpha"]);
  });

  it("creates a real grammY bot only when the webhook layer asks for it", function assertLazyTelegramBotCreation() {
    const tenants = readTenantRegistry(TEST_ENV);
    const runtime = getTelegramRuntime(tenants.alpha);
    const bot = runtime.createBot("123456:telegram-token");

    expect(bot).toBeInstanceOf(Bot);
    expect(bot.botInfo?.username).toBe("alpha_bootstrap_bot");
  });

  it("normalizes the synthetic username when the tenant id has operational characters", function assertBootstrapUsernameNormalization() {
    const runtime = getTelegramRuntime({
      tenantId: "alpha-prod.internal",
      displayName: "Alpha Prod",
      splitConfig: {
        depixSplitAddress: "split-address-alpha-prod",
        splitFee: "12.50",
      },
      secretBindings: {
        telegramBotToken: "ALPHA_TELEGRAM_BOT_TOKEN",
        telegramWebhookSecret: "ALPHA_TELEGRAM_WEBHOOK_SECRET",
        eulenApiToken: "ALPHA_EULEN_API_TOKEN",
        eulenWebhookSecret: "ALPHA_EULEN_WEBHOOK_SECRET",
      },
    });

    expect(runtime.botInfo.username).toBe("alpha_prod_internal_bootstrap_bot");
  });

  it("reuses the same runtime instance for repeated access", function assertTelegramRuntimeReuse() {
    const tenants = readTenantRegistry(TEST_ENV);
    const firstRuntime = getTelegramRuntime(tenants.alpha);
    const secondRuntime = getTelegramRuntime(tenants.alpha);

    expect(secondRuntime).toBe(firstRuntime);
  });
});
