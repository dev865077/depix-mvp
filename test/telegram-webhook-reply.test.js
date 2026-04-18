/**
 * Testes do fluxo inicial de resposta do bot Telegram.
 *
 * A suite cobre o caminho minimo do issue #50:
 * - update entra pela rota real do webhook
 * - o runtime seleciona o handler correto
 * - o bot produz webhook reply com a Bot API adequada ao tipo do update
 * - erros outbound sao mapeados para contrato HTTP local
 * - requests fora de escopo nao geram retry operacional desnecessario
 */
import { BotError, GrammyError, HttpError } from "grammy";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { handleTelegramWebhook } from "../src/routes/telegram.js";
import { normalizeTelegramBotError } from "../src/telegram/errors.js";
import {
  buildTelegramStartReply,
  buildTelegramTextReply,
  buildTelegramUnsupportedCallbackReply,
  buildTelegramUnsupportedMessageReply,
} from "../src/telegram/reply-flow.js";
import { clearTelegramRuntimeCache } from "../src/telegram/runtime.js";

/**
 * Monta um `env` minimo para os testes do webhook do Telegram.
 *
 * O registry define os tenants de forma explicita para validar o roteamento
 * por URL e o texto tenant-aware das respostas.
 *
 * @param {Record<string, unknown>} [overrides] Sobrescritas pontuais.
 * @returns {Record<string, unknown>} `env` final do Worker.
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
    }),
    ALPHA_TELEGRAM_BOT_TOKEN: "123456:alpha-test-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: "alpha-split-address",
    ALPHA_DEPIX_SPLIT_FEE: "1.00%",
    BETA_TELEGRAM_BOT_TOKEN: "654321:beta-test-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
    BETA_DEPIX_SPLIT_ADDRESS: "beta-split-address",
    BETA_DEPIX_SPLIT_FEE: "1.00%",
    ...overrides,
  };
}

/**
 * Monta um update simples de mensagem de texto.
 *
 * @param {{ text: string, chatId: number, fromId: number, updateId?: number }} input Dados do update.
 * @returns {string} JSON do update pronto para o webhook.
 */
function createTelegramTextUpdate(input) {
  const message = {
    message_id: 10,
    date: 1713434400,
    text: input.text,
    chat: {
      id: input.chatId,
      type: "private",
    },
    from: {
      id: input.fromId,
      is_bot: false,
      first_name: "Pedro",
    },
  };

  if (input.text.startsWith("/")) {
    message.entities = [
      {
        type: "bot_command",
        offset: 0,
        length: input.text.split(/\s+/u)[0].length,
      },
    ];
  }

  return JSON.stringify({
    update_id: input.updateId ?? 1,
    message,
  });
}

/**
 * Monta um update de callback query.
 *
 * @param {{ chatId: number, fromId: number, updateId?: number }} input Dados do update.
 * @returns {string} JSON do update pronto para o webhook.
 */
function createTelegramCallbackQueryUpdate(input) {
  return JSON.stringify({
    update_id: input.updateId ?? 3,
    callback_query: {
      id: `callback-${input.updateId ?? 3}`,
      from: {
        id: input.fromId,
        is_bot: false,
        first_name: "Pedro",
      },
      chat_instance: "chat-instance-1",
      data: "noop",
      message: {
        message_id: 11,
        date: 1713434403,
        chat: {
          id: input.chatId,
          type: "private",
        },
      },
    },
  });
}

/**
 * Monta um update sem canal de resposta enderecavel.
 *
 * @param {{ fromId: number, updateId?: number }} input Dados do update.
 * @returns {string} JSON do update pronto para o webhook.
 */
function createTelegramInlineQueryUpdate(input) {
  return JSON.stringify({
    update_id: input.updateId ?? 4,
    inline_query: {
      id: `inline-${input.updateId ?? 4}`,
      from: {
        id: input.fromId,
        is_bot: false,
        first_name: "Pedro",
      },
      query: "noop",
      offset: "",
    },
  });
}

afterEach(function resetTelegramTests() {
  vi.restoreAllMocks();
  clearTelegramRuntimeCache();
});

describe("telegram webhook reply flow", () => {
  it("returns a tenant-aware webhook reply for /start and emits structured logs", async function assertStartReplyFlow() {
    const app = createApp();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");
      expect(payload.chat_id).toBe(1001);
      expect(payload.text).toBe(buildTelegramStartReply({
        displayName: "Alpha",
      }));

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 1,
          date: 1713434401,
          text: payload.text,
          chat: {
            id: payload.chat_id,
            type: "private",
          },
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 1001,
          fromId: 501,
        }),
      },
      createWorkerEnv(),
    );
    const body = await response.text();
    const logRecords = consoleSpy.mock.calls.map(([entry]) => JSON.parse(entry));

    expect(response.status).toBe(200);
    expect(body).toBe("");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(logRecords.some((record) => record.message === "telegram.update.received")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.handler.selected")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.outbound.attempt")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.outbound.succeeded")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.handler.completed")).toBe(true);
  });

  it("routes plain text replies by tenant", async function assertTenantAwareTextReply() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot654321:beta-test-token/sendMessage");
      expect(payload.chat_id).toBe(2002);
      expect(payload.text).toBe(buildTelegramTextReply({
        displayName: "Beta",
      }));

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 2,
          date: 1713434402,
          text: payload.text,
          chat: {
            id: payload.chat_id,
            type: "private",
          },
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const response = await app.request(
      "https://example.com/telegram/beta/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "beta-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "teste",
          chatId: 2002,
          fromId: 502,
          updateId: 2,
        }),
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("handles callback queries through answerCallbackQuery", async function assertCallbackQueryFallback() {
    const app = createApp();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/answerCallbackQuery");
      expect(payload.callback_query_id).toBe("callback-3");
      expect(payload.text).toBe(buildTelegramUnsupportedCallbackReply({
        displayName: "Alpha",
      }));

      return new Response(JSON.stringify({
        ok: true,
        result: true,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramCallbackQueryUpdate({
          chatId: 3003,
          fromId: 503,
          updateId: 3,
        }),
      },
      createWorkerEnv(),
    );
    const logRecords = consoleSpy.mock.calls.map(([entry]) => JSON.parse(entry));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(logRecords.some((record) => record.details?.handlerName === "unsupported_update_reply")).toBe(true);
  });

  it("logs and acknowledges unsupported updates without a reply channel", async function assertNoReplySurfaceFallback() {
    const app = createApp();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function unexpectedFetch() {
      throw new Error("unsupported update without reply channel should not call Telegram API");
    });

    const response = await app.request(
      "https://example.com/telegram/beta/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "beta-telegram-secret",
        },
        body: createTelegramInlineQueryUpdate({
          fromId: 504,
          updateId: 4,
        }),
      },
      createWorkerEnv(),
    );
    const logRecords = consoleSpy.mock.calls.map(([entry]) => JSON.parse(entry));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logRecords.some((record) => record.message === "telegram.outbound.skipped")).toBe(true);
    expect(logRecords.some((record) => record.details?.handlerName === "unsupported_update_reply")).toBe(true);
  });

  it("returns a message reply for unsupported message updates", async function assertUnsupportedMessageReply() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot654321:beta-test-token/sendMessage");
      expect(payload.chat_id).toBe(5005);
      expect(payload.text).toBe(buildTelegramUnsupportedMessageReply({
        displayName: "Beta",
      }));

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 5,
          date: 1713434405,
          text: payload.text,
          chat: {
            id: payload.chat_id,
            type: "private",
          },
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const response = await app.request(
      "https://example.com/telegram/beta/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "beta-telegram-secret",
        },
        body: JSON.stringify({
          update_id: 5,
          message: {
            message_id: 12,
            date: 1713434405,
            photo: [{ file_id: "photo-1", width: 100, height: 100 }],
            chat: {
              id: 5005,
              type: "private",
            },
            from: {
              id: 505,
              is_bot: false,
              first_name: "Pedro",
            },
          },
        }),
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("telegram webhook route behavior", () => {
  it("acknowledges requests without tenant context to avoid Telegram retries", async function assertMissingTenantAck() {
    const response = await handleTelegramWebhook({
      env: createWorkerEnv(),
      req: {
        method: "POST",
        path: "/telegram/missing/webhook",
        raw: new Request("https://example.com/telegram/missing/webhook", {
          method: "POST",
        }),
      },
      get(key) {
        if (key === "runtimeConfig") {
          return {
            app: {
              name: "depix-mvp",
              env: "local",
            },
            logging: {
              level: "debug",
            },
          };
        }

        if (key === "requestId") {
          return "missing-tenant-request";
        }

        return undefined;
      },
      res: undefined,
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

describe("telegram outbound failure mapping", () => {
  it("maps Bot API errors into a structured webhook error", function assertGrammyErrorMapping() {
    const botError = new BotError(
      new GrammyError(
        "Forbidden",
        {
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
          parameters: {},
        },
        "sendMessage",
        {
          chat_id: 3003,
          text: "ola",
        },
      ),
      {
        update: {
          update_id: 7,
          message: {
            text: "teste",
            chat: {
              id: 3003,
            },
            from: {
              id: 503,
            },
          },
        },
        state: {
          telegramHandler: "text_message_reply",
        },
      },
    );

    const error = normalizeTelegramBotError(botError);

    expect(error.status).toBe(502);
    expect(error.code).toBe("telegram_outbound_request_failed");
    expect(error.details.method).toBe("sendMessage");
    expect(error.details.errorCode).toBe(403);
    expect(error.details.handlerName).toBe("text_message_reply");
    expect(error.details.chatId).toBe(3003);
  });

  it("maps transport failures into a structured webhook error", function assertHttpErrorMapping() {
    const botError = new BotError(
      new HttpError("sendMessage failed", new Error("network unreachable")),
      {
        update: {
          update_id: 8,
          message: {
            text: "/start",
            chat: {
              id: 4004,
            },
            from: {
              id: 504,
            },
          },
        },
        state: {
          telegramHandler: "start_command",
        },
      },
    );

    const error = normalizeTelegramBotError(botError);

    expect(error.status).toBe(502);
    expect(error.code).toBe("telegram_outbound_transport_failed");
    expect(error.details.handlerName).toBe("start_command");
    expect(error.details.chatId).toBe(4004);
    expect(error.details.cause).toContain("network unreachable");
  });
});
