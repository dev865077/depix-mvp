/**
 * Testes da fundacao multi-tenant do Worker.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { resetDatabaseSchema } from "./db.repositories.test.js";

async function fetchJson(url) {
  const response = await SELF.fetch(url, { method: "POST" });
  const body = await response.json();

  return { response, body };
}

function createWorkerEnv() {
  return {
    DB: env.DB,
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    EULEN_API_BASE_URL: "https://depix.eulen.app/api",
    EULEN_API_TIMEOUT_MS: "10000",
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
      beta: {
        displayName: "Beta",
        eulenPartnerId: "partner-beta",
        splitConfig: {
          depixSplitAddress: "split-address-beta",
          splitFee: "15.00",
        },
        secretBindings: {
          telegramBotToken: "BETA_TELEGRAM_BOT_TOKEN",
          telegramWebhookSecret: "BETA_TELEGRAM_WEBHOOK_SECRET",
          eulenApiToken: "BETA_EULEN_API_TOKEN",
          eulenWebhookSecret: "BETA_EULEN_WEBHOOK_SECRET",
        },
      },
    }),
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

describe("tenant routing", () => {
  it("resolves tenant on telegram webhook path", async function assertTelegramTenantRouting() {
    const { response, body } = await fetchJson("https://example.com/telegram/alpha/webhook");

    expect(response.status).toBe(501);
    expect(body.tenantId).toBe("alpha");
    expect(body.error.details.tenantDisplayName).toBe("Alpha");
    expect(body.error.details.telegramRuntime).toBe("grammy");
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
});
