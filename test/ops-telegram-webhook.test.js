/**
 * Testes das rotas operacionais autenticadas de webhook do Telegram.
 *
 * Estas rotas existem para suporte real em `test` e `production`, entao a
 * suite cobre o contrato que importa:
 * - bearer operacional obrigatorio
 * - leitura segura do estado atual do webhook
 * - registro explicito do webhook com `secret_token`
 * - falha fechada quando o ambiente nao materializa os segredos do tenant
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

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

/**
 * Monta um env minimo e deterministico para as rotas `/ops`.
 *
 * @param {Record<string, unknown>=} overrides Sobrescritas pontuais.
 * @returns {Record<string, unknown>} Bindings do Worker usados na suite.
 */
function createWorkerEnv(overrides = {}) {
  return {
    DB: env.DB,
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    EULEN_API_BASE_URL: "https://depix.eulen.app/api",
    EULEN_API_TIMEOUT_MS: "10000",
    TENANT_REGISTRY,
    OPS_ROUTE_BEARER_TOKEN: "ops-route-test-token",
    ALPHA_TELEGRAM_BOT_TOKEN: "123456:alpha-test-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: "split-address-alpha",
    ALPHA_DEPIX_SPLIT_FEE: "1.00%",
    ...overrides,
  };
}

/**
 * Executa uma request JSON contra o app em memoria.
 *
 * @param {import("../src/app.js").createApp extends (...args: any[]) => infer T ? T : never} app App criado para o teste.
 * @param {string} url URL alvo.
 * @param {RequestInit} init Init HTTP da chamada.
 * @param {Record<string, unknown>} workerEnv Env do Worker.
 * @returns {Promise<{ response: Response, body: any }>} Resposta e JSON parseado.
 */
async function requestJson(app, url, init, workerEnv) {
  const response = await app.request(url, init, workerEnv);
  const body = await response.json();

  return { response, body };
}

afterEach(function restoreTelegramWebhookOpsMocks() {
  vi.restoreAllMocks();
});

describe("ops telegram webhook routes", () => {
  it("returns structured webhook info when the operator bearer token is valid", async function assertWebhookInfoSuccess() {
    const app = createApp();

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input) {
      const url = String(input);

      if (url.includes("/getMe")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            id: 123456,
            is_bot: true,
            username: "depix_alpha_test_bot",
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/getWebhookInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            url: "https://depix-mvp-test.dev865077.workers.dev/telegram/alpha/webhook",
            pending_update_count: 0,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected Telegram method call: ${url}`);
    });

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/webhook-info?publicBaseUrl=https://depix-mvp-test.dev865077.workers.dev",
      {
        method: "GET",
        headers: {
          authorization: "Bearer ops-route-test-token",
        },
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tenantId).toBe("alpha");
    expect(body.expectedWebhookUrl).toBe("https://depix-mvp-test.dev865077.workers.dev/telegram/alpha/webhook");
    expect(body.telegramApi.getMeHttpStatus).toBe(200);
    expect(body.bot.username).toBe("depix_alpha_test_bot");
    expect(body.webhook.url).toBe("https://depix-mvp-test.dev865077.workers.dev/telegram/alpha/webhook");
  });

  it("ignores the legacy baseUrl query alias so the ops contract stays canonical", async function assertWebhookInfoCanonicalQueryContract() {
    const app = createApp();

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input) {
      const url = String(input);

      if (url.includes("/getMe")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            id: 123456,
            is_bot: true,
            username: "depix_alpha_test_bot",
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/getWebhookInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            url: "https://depix-mvp-test.dev865077.workers.dev/telegram/alpha/webhook",
            pending_update_count: 0,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected Telegram method call: ${url}`);
    });

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/webhook-info?baseUrl=https://depix-mvp-test.dev865077.workers.dev",
      {
        method: "GET",
        headers: {
          authorization: "Bearer ops-route-test-token",
        },
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.expectedWebhookUrl).toBeNull();
  });

  it("registers the tenant webhook with secret token and message-only updates", async function assertWebhookRegistrationSuccess() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);

      if (url.includes("/setWebhook")) {
        return new Response(JSON.stringify({
          ok: true,
          result: true,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/getWebhookInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            url: "https://depix-mvp-test.dev865077.workers.dev/telegram/alpha/webhook",
            pending_update_count: 0,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected Telegram method call: ${url}`);
    });

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/register-webhook",
      {
        method: "POST",
        headers: {
          authorization: "Bearer ops-route-test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicBaseUrl: "https://depix-mvp-test.dev865077.workers.dev",
        }),
      },
      createWorkerEnv(),
    );
    const setWebhookPayload = JSON.parse(fetchSpy.mock.calls[0][1]?.body ?? "{}");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.webhookUrl).toBe("https://depix-mvp-test.dev865077.workers.dev/telegram/alpha/webhook");
    expect(body.registered).toBe(true);
    expect(body.webhook.url).toBe("https://depix-mvp-test.dev865077.workers.dev/telegram/alpha/webhook");
    expect(setWebhookPayload.url).toBe("https://depix-mvp-test.dev865077.workers.dev/telegram/alpha/webhook");
    expect(setWebhookPayload.secret_token).toBe("alpha-telegram-secret");
    expect(setWebhookPayload.allowed_updates).toEqual(["message"]);
  });

  it("rejects webhook info without operator bearer token", async function assertMissingAuth() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/webhook-info",
      {
        method: "GET",
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("ops_authorization_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects webhook registration with an invalid operator bearer token", async function assertInvalidAuth() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/register-webhook",
      {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicBaseUrl: "https://depix-mvp-test.dev865077.workers.dev",
        }),
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ops_authorization_invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires bearer auth on webhook registration even when local diagnostics are enabled", async function assertRegisterRouteAuthBoundary() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/register-webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicBaseUrl: "https://depix-mvp-test.dev865077.workers.dev",
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
      }),
    );

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("ops_authorization_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires explicit publicBaseUrl to avoid registering the webhook against the wrong host", async function assertExplicitPublicBaseUrlRequirement() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/register-webhook",
      {
        method: "POST",
        headers: {
          authorization: "Bearer ops-route-test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("public_base_url_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the route bearer-protected even when local diagnostics are enabled", async function assertLocalDiagnosticsDoesNotBypassAuth() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/webhook-info",
      {
        method: "GET",
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
      }),
    );

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("ops_authorization_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the worker cannot resolve the Telegram bot secret", async function assertMissingTelegramSecret() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/telegram/webhook-info",
      {
        method: "GET",
        headers: {
          authorization: "Bearer ops-route-test-token",
        },
      },
      createWorkerEnv({
        ALPHA_TELEGRAM_BOT_TOKEN: undefined,
      }),
    );

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("telegram_webhook_dependency_unavailable");
    expect(body.error.details.secretKey).toBe("telegramBotToken");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
