// @vitest-pool cloudflare
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  consumeWebhookRateLimit,
  getWebhookRateLimitBucketCountForTests,
  resetWebhookRateLimitStateForTests,
  WEBHOOK_RATE_LIMIT_POLICY,
  type WebhookRateLimitScope,
} from "../src/middleware/webhook-rate-limit.js";
import { createTenantRegistryKv } from "./helpers/tenant-registry-kv.js";

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
});

function createWorkerEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: env.DB,
    APP_NAME: "depix-mvp",
    APP_ENV: "test",
    LOG_LEVEL: "debug",
    EULEN_API_BASE_URL: "https://depix.eulen.app/api",
    EULEN_API_TIMEOUT_MS: "10000",
    TENANT_REGISTRY_KV: createTenantRegistryKv(TENANT_REGISTRY),
    ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK: "false",
    ALPHA_TELEGRAM_BOT_TOKEN: "123456:alpha-test-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: "split-address-alpha",
    ALPHA_DEPIX_SPLIT_FEE: "12.50%",
    ...overrides,
  };
}

function seedBlockedWebhookBucket(scope: WebhookRateLimitScope, clientIp: string): void {
  for (let attempt = 0; attempt < WEBHOOK_RATE_LIMIT_POLICY.limit; attempt += 1) {
    const result = consumeWebhookRateLimit({
      scope,
      tenantId: "alpha",
      clientIp,
    });

    expect(result.allowed).toBe(true);
  }
}

async function expectRateLimitedResponse(response: Response, expectedScope: WebhookRateLimitScope): Promise<void> {
  const body = await response.json();
  const retryAfter = Number(response.headers.get("Retry-After"));

  expect(response.status).toBe(429);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect(body.error.code).toBe("rate_limit_exceeded");
  expect(body.error.details.scope).toBe(expectedScope);
  expect(body.error.details.limit).toBe(WEBHOOK_RATE_LIMIT_POLICY.limit);
  expect(body.error.details.windowSeconds).toBe(60);
}

beforeEach(function resetRateLimitState() {
  resetWebhookRateLimitStateForTests();
});

afterEach(function resetRateLimitStateAfterTest() {
  resetWebhookRateLimitStateForTests();
});

describe("webhook rate limiting", () => {
  it("allows requests until the fixed window limit and blocks the next one", function assertFixedWindowPolicy() {
    const nowMs = 1_800_000;

    for (let attempt = 1; attempt <= WEBHOOK_RATE_LIMIT_POLICY.limit; attempt += 1) {
      const result = consumeWebhookRateLimit({
        scope: "telegram_webhook",
        tenantId: "alpha",
        clientIp: "203.0.113.10",
        nowMs,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(WEBHOOK_RATE_LIMIT_POLICY.limit - attempt);
    }

    const blocked = consumeWebhookRateLimit({
      scope: "telegram_webhook",
      tenantId: "alpha",
      clientIp: "203.0.113.10",
      nowMs,
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("evicts expired buckets before tracking new webhook keys", function assertExpiredBucketEviction() {
    const nowMs = 2_400_000;

    for (let index = 0; index < 100; index += 1) {
      consumeWebhookRateLimit({
        scope: "telegram_webhook",
        tenantId: "alpha",
        clientIp: `198.51.100.${index}`,
        nowMs,
      });
    }

    expect(getWebhookRateLimitBucketCountForTests()).toBe(100);

    consumeWebhookRateLimit({
      scope: "eulen_deposit_webhook",
      tenantId: "alpha",
      clientIp: "203.0.113.200",
      nowMs: nowMs + WEBHOOK_RATE_LIMIT_POLICY.windowMs + 1,
    });

    expect(getWebhookRateLimitBucketCountForTests()).toBe(1);
  });

  it("does not use isolate memory as the primary webhook protection", async function assertFallbackDisabledByDefault() {
    const clientIp = "203.0.113.15";
    const app = createApp();

    seedBlockedWebhookBucket("telegram_webhook", clientIp);

    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": clientIp,
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: JSON.stringify({
          update_id: 10000,
          message: {
            message_id: 1,
            date: 1710000000,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false, first_name: "Tester" },
            text: "/start",
          },
        }),
      },
      createWorkerEnv(),
    );

    expect(response.status).not.toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  it("returns 429 with Retry-After for Telegram webhook overflow by IP and tenant", async function assertTelegramWebhookLimit() {
    const clientIp = "203.0.113.20";
    const app = createApp();

    seedBlockedWebhookBucket("telegram_webhook", clientIp);

    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": clientIp,
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: JSON.stringify({
          update_id: 10000,
          message: {
            message_id: 1,
            date: 1710000000,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false, first_name: "Tester" },
            text: "/start",
          },
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK: "true",
      }),
    );

    await expectRateLimitedResponse(response, "telegram_webhook");
  });

  it("returns 429 with Retry-After for Eulen deposit webhook overflow by IP and tenant", async function assertEulenWebhookLimit() {
    const clientIp = "203.0.113.30";
    const app = createApp();

    seedBlockedWebhookBucket("eulen_deposit_webhook", clientIp);

    const response = await app.request(
      "https://example.com/webhooks/eulen/alpha/deposit",
      {
        method: "POST",
        headers: {
          authorization: "Basic alpha-eulen-secret",
          "cf-connecting-ip": clientIp,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          webhookType: "deposit",
          qrId: "missing-deposit",
          status: "pending",
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK: "true",
      }),
    );

    await expectRateLimitedResponse(response, "eulen_deposit_webhook");
  });
});
