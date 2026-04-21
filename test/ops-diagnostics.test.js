/**
 * Testes das rotas locais de diagnostico operacional.
 *
 * O foco aqui e garantir que o gate local, as validacoes de entrada e o
 * mapeamento de erro permaneçam estaveis. Isso protege a instrumentacao usada
 * na issue #42 sem depender de chamadas externas reais durante a suite.
 */
// @vitest-pool cloudflare
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { resetDatabaseSchema } from "./helpers/database-schema.js";

const MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS = `lq1${"q".repeat(98)}`;
const MOCK_VISUALLY_GROUPED_LIQUID_SPLIT_ADDRESS = [
  MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS.slice(0, 24),
  MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS.slice(24, 56),
  MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS.slice(56),
].join(" ");

/**
 * Monta um `env` em memoria para `cloudflare:test`.
 *
 * Esses valores nao sao configuracao produtiva hardcoded. Em `wrangler dev
 * --remote` e nos deploys, os bindings `ALPHA_*` sao materializados pela
 * Secrets Store da Cloudflare conforme o `wrangler.jsonc`. A suite precisa
 * fornecer fixtures deterministicas porque ela roda isolada do Secrets Store.
 */
function createWorkerEnv(overrides = {}) {
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
    }),
    ALPHA_TELEGRAM_BOT_TOKEN: "123456:alpha-test-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: "split-address-alpha",
    ALPHA_DEPIX_SPLIT_FEE: "12.50%",
    ...overrides,
  };
}

async function requestJson(app, url, init, workerEnv) {
  const response = await app.request(url, init, workerEnv);
  const body = await response.json();

  return { response, body };
}

afterEach(function restoreMocks() {
  vi.restoreAllMocks();
});

describe("ops diagnostics routes", () => {
  it("hide diagnostics routes unless local diagnostics are explicitly enabled", async function assertRouteGate() {
    const app = createApp();
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/ping",
      { method: "GET" },
      createWorkerEnv(),
    );

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("diagnostic_route_unavailable");
  });

  it("rejects malformed JSON bodies before any side effect runs", async function assertInvalidJsonBody() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/create-deposit",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{invalid-json",
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
      }),
    );

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_json_body");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsupported async modes before calling Eulen", async function assertInvalidAsyncMode() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/ping?asyncMode=later",
      { method: "GET" },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
      }),
    );

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_async_mode");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("includes async mode in structured Eulen diagnostic failures", async function assertEulenErrorIncludesAsyncMode() {
    const app = createApp();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error code: 520", {
        status: 520,
      }),
    );

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/ping?asyncMode=false",
      { method: "GET" },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
      }),
    );

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("eulen_api_request_failed");
    expect(body.error.details.asyncMode).toBe("false");
    expect(body.error.details.status).toBe(520);
  });

  it("uses asynchronous Eulen mode by default on ping diagnostics", async function assertDefaultPingAsyncMode() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        response: {
          msg: "Pong!",
        },
        async: false,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/ping",
      { method: "GET" },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
      }),
    );

    expect(response.status).toBe(200);
    expect(body.response.asyncMode).toBe("true");
    expect(fetchSpy.mock.calls[0][1]?.headers.get("X-Async")).toBe("true");
  });

  it("rejects invalid deposit amounts before attempting persistence or upstream calls", async function assertInvalidAmount() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/create-deposit",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amountInCents: 0,
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
      }),
    );

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_amount_in_cents");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects placeholder split config before attempting a real Eulen deposit", async function assertPlaceholderSplitConfig() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/create-deposit",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amountInCents: 100,
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
      }),
    );

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("diagnostic_split_config_not_ready");
    expect(body.error.details.tenantId).toBe("alpha");
    expect(body.error.details.depixSplitAddressLooksPlaceholder).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps missing split config secrets before attempting a real Eulen deposit", async function assertMissingSplitSecretMapping() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/create-deposit",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amountInCents: 100,
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
        ALPHA_DEPIX_SPLIT_ADDRESS: undefined,
      }),
    );

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("diagnostic_split_config_unavailable");
    expect(body.error.details.tenantId).toBe("alpha");
    expect(body.error.details.splitConfigBindings.depixSplitAddress).toBe("ALPHA_DEPIX_SPLIT_ADDRESS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts SideSwap liquid confidential split addresses and removes visual spacing", async function assertSideSwapSplitAddressFormat() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error code: 520", {
        status: 520,
      }),
    );

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/create-deposit",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amountInCents: 100,
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
        ALPHA_DEPIX_SPLIT_ADDRESS: MOCK_VISUALLY_GROUPED_LIQUID_SPLIT_ADDRESS,
        ALPHA_DEPIX_SPLIT_FEE: "1.00%",
      }),
    );
    const eulenPayload = JSON.parse(fetchSpy.mock.calls[0][1].body);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(eulenPayload.depixSplitAddress).toBe(MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS);
    expect(response.status).toBe(502);
    expect(body.error.code).toBe("eulen_api_request_failed");
    expect(body.error.details.splitConfigDiagnostics.depixSplitAddressKind).toBe("liquid-confidential");
    expect(body.error.details.splitConfigDiagnostics.depixSplitAddressLength)
      .toBe(MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS.length);
  });

  it("redacts split config values on upstream deposit failures", async function assertRedactedSplitDiagnostics() {
    const app = createApp();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error code: 520", {
        status: 520,
      }),
    );

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/create-deposit",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amountInCents: 100,
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
        ALPHA_DEPIX_SPLIT_ADDRESS: ` ${MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS} `,
        ALPHA_DEPIX_SPLIT_FEE: "1.00%",
      }),
    );
    const serializedBody = JSON.stringify(body);

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("eulen_api_request_failed");
    expect(body.error.details.splitConfigDiagnostics.depixSplitAddressLength)
      .toBe(MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS.length);
    expect(body.error.details.splitConfigDiagnostics.depixSplitAddressKind).toBe("liquid-confidential");
    expect(body.error.details.splitConfigDiagnostics.splitFeeLooksPercent).toBe(true);
    expect(serializedBody).not.toContain(MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS);
    expect(serializedBody).not.toContain("1.00%");
  });

  it("resolves asynchronous Eulen deposit responses before persisting the diagnostic aggregate", async function assertAsyncDepositResolution() {
    await resetDatabaseSchema();

    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockAsyncEulenDeposit(input) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        return new Response(JSON.stringify({
          urlResponse: "https://example.com/eulen-async/deposit-success",
          async: true,
          expiration: "2026-04-18T12:00:00.000Z",
        }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-request-id": "eulen-request-async",
          },
        });
      }

      if (url === "https://example.com/eulen-async/deposit-success") {
        return new Response(JSON.stringify({
          id: "deposit_async_001",
          qrCopyPaste: "00020101021226asyncqr",
          qrImageUrl: "https://example.com/qr/deposit_async_001.png",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/create-deposit",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amountInCents: 1000,
          asyncMode: "true",
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
        ALPHA_DEPIX_SPLIT_ADDRESS: MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS,
        ALPHA_DEPIX_SPLIT_FEE: "1.00%",
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(body.ok).toBe(true);
    expect(body.deposit.depositEntryId).toBe("deposit_async_001");
    expect(body.deposit.qrId).toBeNull();
    expect(body.deposit.externalStatus).toBe("pending");
    expect(body.response.data.resolvedFromAsync).toBe(true);
  });

  it("maps asynchronous Eulen deposit errors into structured diagnostic failures", async function assertAsyncDepositErrorMapping() {
    const app = createApp();

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockAsyncEulenDepositError(input) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        return new Response(JSON.stringify({
          urlResponse: "https://example.com/eulen-async/deposit-error",
          async: true,
          expiration: "2026-04-18T12:00:00.000Z",
        }), {
          status: 202,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url === "https://example.com/eulen-async/deposit-error") {
        return new Response(JSON.stringify({
          errorMessage: "The split portion exceeds the maximum allowed for this amount.",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/create-deposit",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amountInCents: 100,
          asyncMode: "true",
        }),
      },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
        ALPHA_DEPIX_SPLIT_ADDRESS: MOCK_LIQUID_CONFIDENTIAL_SPLIT_ADDRESS,
        ALPHA_DEPIX_SPLIT_FEE: "1.00%",
      }),
    );

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("eulen_async_deposit_failed");
    expect(body.error.details.errorMessage).toContain("split portion exceeds");
  });

  it("allows Eulen diagnostics to run without unrelated Telegram secret values", async function assertEulenSecretIsolation() {
    const app = createApp();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        response: {
          msg: "Pong!",
        },
        async: false,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/ping?asyncMode=false",
      { method: "GET" },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
        ALPHA_TELEGRAM_BOT_TOKEN: undefined,
        ALPHA_TELEGRAM_WEBHOOK_SECRET: undefined,
      }),
    );

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tenantId).toBe("alpha");
    expect(body.response.data.response.msg).toBe("Pong!");
  });

  it("maps missing tenant secrets into structured diagnostic errors", async function assertMissingSecretMapping() {
    const app = createApp();
    const { response, body } = await requestJson(
      app,
      "https://example.com/ops/alpha/eulen/ping?asyncMode=false",
      { method: "GET" },
      createWorkerEnv({
        ENABLE_LOCAL_DIAGNOSTICS: "true",
        ALPHA_EULEN_API_TOKEN: undefined,
      }),
    );

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("diagnostic_secret_unavailable");
    expect(body.error.details.secretKey).toBe("eulenApiToken");
    expect(body.error.details.bindingName).toBe("ALPHA_EULEN_API_TOKEN");
  });
});
