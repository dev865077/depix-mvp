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
// @vitest-pool cloudflare
import { BotError, GrammyError, HttpError } from "grammy";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { getDatabase } from "../src/db/client.js";
import { createDeposit, getLatestDepositByOrderId } from "../src/db/repositories/deposits-repository.js";
import { createOrder, getLatestOpenOrderByUser } from "../src/db/repositories/orders-repository.js";
import { handleTelegramWebhook } from "../src/routes/telegram.js";
import { createTelegramOrderDepositNonce } from "../src/services/telegram-order-nonce.js";
import { clearTelegramWebhookPublicSurfaceEnsureCache } from "../src/services/telegram-webhook-ops.js";
import { MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS } from "../src/telegram/brl-amount.js";
import { normalizeTelegramBotError } from "../src/telegram/errors.js";
import {
  buildTelegramHelpReply,
  buildTelegramStartReply,
  buildTelegramInvalidAmountReply,
  buildTelegramUnsupportedCallbackReply,
  buildTelegramUnsupportedMessageReply,
} from "../src/telegram/reply-flow.js";
import { clearTelegramRuntimeCache } from "../src/telegram/runtime.js";
import { withTenantRegistryKv } from "./helpers/tenant-registry-kv.js";

const SIDESWAP_LQ_ADDRESS = "lq1qqt6tf80s4c8k5n5v88smk40d5cqh6wp63025cwypeemlh3ra84xgfng64m08lv69d9wau62vag5alxyvzv8hq8qqn9sjtr4pd";
const EX_ADDRESS = "ex1qhuq5u7udzwskhaz45fy80kdaxjytqd99ju5yfn";
const GROUPED_SIDESWAP_LQ_ADDRESS = [
  "lq1qqt6tf80s4c8k5n5v88smk40d5cqh6wp63025",
  "cwypeemlh3ra84xgfng64m08lv69d9wau62vag5al",
  "xyvzv8hq8qqn9sjtr4pd",
].join(" \n ");

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
  const tenantRegistry = JSON.stringify({
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

  return {
    DB: env.DB,
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    EULEN_API_BASE_URL: "https://depix.eulen.app/api",
    EULEN_API_TIMEOUT_MS: "10000",
    ALPHA_TELEGRAM_BOT_TOKEN: "123456:alpha-test-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: SIDESWAP_LQ_ADDRESS,
    ALPHA_DEPIX_SPLIT_FEE: "1.00%",
    BETA_TELEGRAM_BOT_TOKEN: "654321:beta-test-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
    BETA_DEPIX_SPLIT_ADDRESS: EX_ADDRESS,
    BETA_DEPIX_SPLIT_FEE: "1.00%",
    ...withTenantRegistryKv(overrides, tenantRegistry),
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
 * Envolve o binding D1 para injetar uma falha transiente no proximo batch.
 *
 * O fluxo de confirmacao usa `db.batch()` para criar o deposito local; essa
 * falha simula o ponto sensivel em que a Eulen ja retornou uma cobranca, mas o
 * D1 ainda nao conseguiu persisti-la.
 *
 * @param {D1Database} db Binding D1 real do teste.
 * @param {Error} error Falha a injetar.
 * @returns {D1Database} Binding proxy.
 */
function createOnceFailingBatchDatabase(db, error) {
  let shouldFail = true;

  return {
    prepare: db.prepare.bind(db),
    dump: db.dump?.bind(db),
    exec: db.exec?.bind(db),
    batch: async function batchWithInjectedFailure(statements) {
      if (shouldFail) {
        shouldFail = false;
        throw error;
      }

      return db.batch(statements);
    },
  };
}

/**
 * Simula um vencedor concorrente terminal exatamente antes da tentativa de
 * reparar um pedido com deposito local para `awaiting_payment`.
 *
 * @param {D1Database} db Binding D1 real do teste.
 * @param {{ tenantId: string, orderId: string, currentStep: string, status: string }} winner Estado vencedor persistido.
 * @returns {D1Database} Binding proxy.
 */
function createAwaitingPaymentConflictDatabase(db, winner) {
  let shouldConflict = true;

  return {
    prepare(sql) {
      const prepared = db.prepare(sql);

      return {
        bind(...args) {
          const bound = prepared.bind(...args);

          return {
            first: async function firstWithAwaitingPaymentConflict() {
              const isAwaitingPaymentGuard = shouldConflict
                && String(sql).includes("UPDATE orders")
                && String(sql).includes("AND current_step = ?")
                && args.includes("awaiting_payment")
                && args.includes("creating_deposit");

              if (isAwaitingPaymentGuard) {
                shouldConflict = false;
                await db
                  .prepare("UPDATE orders SET current_step = ?, status = ?, updated_at = ? WHERE tenant_id = ? AND order_id = ?")
                  .bind(winner.currentStep, winner.status, new Date().toISOString(), winner.tenantId, winner.orderId)
                  .run();
              }

              return bound.first();
            },
            run: bound.run?.bind(bound),
            all: bound.all?.bind(bound),
            raw: bound.raw?.bind(bound),
          };
        },
      };
    },
    dump: db.dump?.bind(db),
    exec: db.exec?.bind(db),
    batch: db.batch.bind(db),
  };
}

/**
 * Monta um update de callback query.
 *
 * @param {{ chatId: number, fromId: number, updateId?: number, data?: string }} input Dados do update.
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
      data: input.data ?? "noop",
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

/**
 * Limpa as tabelas operacionais entre testes do Telegram.
 *
 * Esta suite agora observa persistencia real em `orders`, entao precisamos
 * garantir isolamento explicito para nao herdar linhas de outras suites ou de
 * execucoes anteriores do mesmo arquivo.
 */
async function clearTelegramPersistence() {
  const schemaStatements = [
    "DROP TABLE IF EXISTS deposit_events",
    "DROP TABLE IF EXISTS deposits",
    "DROP TABLE IF EXISTS orders",
    `CREATE TABLE IF NOT EXISTS orders (
      tenant_id TEXT NOT NULL,
      order_id TEXT PRIMARY KEY NOT NULL,
      correlation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'telegram',
      product_type TEXT NOT NULL,
      telegram_chat_id TEXT,
      telegram_canonical_message_id INTEGER,
      telegram_canonical_message_kind TEXT,
      amount_in_cents INTEGER,
      wallet_address TEXT,
      current_step TEXT NOT NULL DEFAULT 'draft',
      status TEXT NOT NULL DEFAULT 'draft',
      split_address TEXT,
      split_fee TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    "CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id)",
    "CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)",
    "CREATE INDEX IF NOT EXISTS orders_tenant_id_idx ON orders (tenant_id)",
    "CREATE INDEX IF NOT EXISTS orders_correlation_id_idx ON orders (correlation_id)",
    "CREATE INDEX IF NOT EXISTS orders_tenant_user_channel_chat_idx ON orders (tenant_id, user_id, channel, telegram_chat_id)",
    `CREATE TABLE IF NOT EXISTS deposits (
      tenant_id TEXT NOT NULL,
      deposit_entry_id TEXT PRIMARY KEY NOT NULL,
      qr_id TEXT,
      order_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_request_id TEXT,
      qr_copy_paste TEXT NOT NULL,
      qr_image_url TEXT NOT NULL,
      external_status TEXT NOT NULL DEFAULT 'pending',
      expiration TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS deposits_tenant_order_unique_idx ON deposits (tenant_id, order_id)",
    `CREATE TABLE IF NOT EXISTS deposit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      tenant_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      deposit_entry_id TEXT NOT NULL,
      qr_id TEXT,
      source TEXT NOT NULL,
      external_status TEXT NOT NULL,
      bank_tx_id TEXT,
      blockchain_tx_id TEXT,
      request_id TEXT,
      raw_payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
      FOREIGN KEY (deposit_entry_id) REFERENCES deposits(deposit_entry_id) ON DELETE CASCADE
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS deposits_tenant_order_unique_idx ON deposits (tenant_id, order_id)",
  ];

  await env.DB.batch(schemaStatements.map((statement) => env.DB.prepare(statement)));
}

beforeEach(async function resetTelegramPersistence() {
  await clearTelegramPersistence();
});

afterEach(function resetTelegramTests() {
  vi.restoreAllMocks();
  clearTelegramRuntimeCache();
  clearTelegramWebhookPublicSurfaceEnsureCache();
});

describe("telegram webhook reply flow", () => {
  it("self-heals production Telegram webhook updates before users press inline buttons", async function assertProductionWebhookAllowedUpdatesRepair() {
    const app = createApp();
    const calls = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : {};

      calls.push({ url, payload });

      if (url.includes("/getWebhookInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            url: "https://depix-mvp-production.dev865077.workers.dev/telegram/alpha/webhook",
            allowed_updates: ["message"],
            pending_update_count: 0,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (
        url.includes("/setWebhook")
        || url.includes("/setMyCommands")
        || url.includes("/setChatMenuButton")
        || url.includes("/setMyDescription")
        || url.includes("/setMyShortDescription")
      ) {
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

      if (url.includes("/sendMessage")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 71,
            chat: {
              id: payload.chat_id,
              type: "private",
            },
            text: payload.text,
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

    const response = await app.request(
      "https://depix-mvp-production.dev865077.workers.dev/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 9101,
          fromId: 9101,
          updateId: 101,
        }),
      },
      createWorkerEnv({
        APP_ENV: "production",
      }),
    );
    const setWebhookPayload = calls.find((call) => call.url.includes("/setWebhook"))?.payload;

    expect(response.status).toBe(200);
    expect(setWebhookPayload?.allowed_updates).toEqual(["message", "callback_query"]);
    expect(calls.some((call) => call.url.includes("/setMyCommands"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/setChatMenuButton"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/setMyDescription"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/setMyShortDescription"))).toBe(true);
  });

  it("returns a tenant-aware webhook reply for /start and emits structured logs", async function assertStartReplyFlow() {
    const app = createApp();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");
      expect(payload.chat_id).toBe(1001);
      expect(payload.text).toContain("Olá! Este é o bot Alpha e te ajudarei a comprar DePix.");
      expect(payload.text).toContain("Esses são meus comandos:");
      expect(payload.text).toContain("/status - consultar seu pedido");
      expect(payload.text).not.toContain("recomecar");
      expect(payload.entities?.some((entity) => entity.type === "bold")).toBe(true);
      expect(payload.reply_markup?.inline_keyboard).toEqual([
        [
          {
            text: "Comprar DePix",
            callback_data: "depix:buy",
          },
        ],
      ]);

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
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(body).toBe("");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(logRecords.some((record) => record.message === "telegram.update.received")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.handler.selected")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.outbound.attempt")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.outbound.succeeded")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.handler.completed")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.order.created")).toBe(true);
    expect(logRecords.some((record) => record.message === "telegram.order.started")).toBe(true);

    const savedOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "501");

    expect(savedOrder?.tenantId).toBe("alpha");
    expect(savedOrder?.userId).toBe("501");
    expect(savedOrder?.telegramChatId).toBe("1001");
    expect(savedOrder?.channel).toBe("telegram");
    expect(savedOrder?.productType).toBe("depix");
    expect(savedOrder?.currentStep).toBe("amount");
    expect(savedOrder?.status).toBe("draft");
    expect(typeof savedOrder?.orderId).toBe("string");
    expect(savedOrder?.orderId.length).toBeGreaterThan(6);
  });

  it("rejects order-bearing Telegram updates without a chat id before creating an order", async function assertMissingChatRejected() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function unexpectedTelegramFetch() {
      throw new Error("Telegram outbound should not be called for malformed order updates.");
    });

    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: JSON.stringify({
          update_id: 501001,
          message: {
            message_id: 501001,
            date: 1713434400,
            text: "/start",
            entities: [
              {
                type: "bot_command",
                offset: 0,
                length: 6,
              },
            ],
            from: {
              id: 501001,
              is_bot: false,
              first_name: "Pedro",
            },
          },
        }),
      },
      createWorkerEnv(),
    );
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "501001");
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_webhook_payload");
    expect(body.error.details.reason).toBe("telegram_chat_missing");
    expect(body.error.details.field).toBe("message.chat");
    expect(currentOrder).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists a large numeric Telegram chat id from the raw webhook payload without precision loss", async function assertLargeRawChatIdPersistence() {
    const app = createApp();
    const largeChatId = "9007199254740993123";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");
      expect(payload.text).toContain("Olá! Este é o bot Alpha e te ajudarei a comprar DePix.");
      expect(payload.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
        text: "Comprar DePix",
        callback_data: "depix:buy",
      });

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 501002,
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
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: `{
          "update_id": 501002,
          "message": {
            "message_id": 501002,
            "date": 1713434402,
            "text": "/start",
            "entities": [
              {
                "type": "bot_command",
                "offset": 0,
                "length": 6
              }
            ],
            "chat": {
              "id": ${largeChatId},
              "type": "private"
            },
            "from": {
              "id": 501002,
              "is_bot": false,
              "first_name": "Pedro"
            }
          }
        }`,
      },
      createWorkerEnv(),
    );
    const savedOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "501002");

    expect(response.status).toBe(200);
    expect(savedOrder?.telegramChatId).toBe(largeChatId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("answers /help without creating a Telegram order", async function assertHelpDoesNotCreateOrder() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");
      expect(payload.chat_id).toBe(13201);
      replies.push(payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 132,
          date: 1713434460,
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
          text: "/help",
          chatId: 13201,
          fromId: 13201,
          updateId: 13201,
        }),
      },
      workerEnv,
    );
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "13201");
    const count = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE tenant_id = ? AND user_id = ? AND channel = ?")
      .bind("alpha", "13201", "telegram")
      .first();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(replies[0]).toBe(buildTelegramHelpReply({ displayName: "Alpha" }, null));
    expect(replies[0]).toContain("lq1 ou ex1");
    expect(replies[0]).toContain("/cancel");
    expect(currentOrder).toBeNull();
    expect(count?.count).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      orderId: "order_help_amount",
      userId: "13211",
      currentStep: "amount",
      status: "draft",
      amountInCents: null,
      walletAddress: null,
      expectedGuidance: "aguardando o valor",
    },
    {
      orderId: "order_help_wallet",
      userId: "13212",
      currentStep: "wallet",
      status: "draft",
      amountInCents: 1000,
      walletAddress: null,
      expectedGuidance: "aguardando o endereço DePix/Liquid",
    },
    {
      orderId: "order_help_confirmation",
      userId: "13213",
      currentStep: "confirmation",
      status: "draft",
      amountInCents: 1000,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      expectedGuidance: "aguardando confirmação",
    },
    {
      orderId: "order_help_creating_deposit",
      userId: "13214",
      currentStep: "creating_deposit",
      status: "processing",
      amountInCents: 1000,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      expectedGuidance: "criando o depósito Pix",
    },
    {
      orderId: "order_help_awaiting_payment",
      userId: "13215",
      currentStep: "awaiting_payment",
      status: "pending",
      amountInCents: 1000,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      expectedGuidance: "aguardando pagamento",
    },
  ])("answers /help from $currentStep without mutating the open order", async function assertHelpDoesNotMutateOrder(entry) {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const replies = [];
    await createOrder(getDatabase(env), {
      tenantId: "beta",
      orderId: entry.orderId,
      userId: entry.userId,
      channel: "telegram",
      productType: "depix",
      amountInCents: entry.amountInCents,
      walletAddress: entry.walletAddress,
      currentStep: entry.currentStep,
      status: entry.status,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot654321:beta-test-token/sendMessage");
      replies.push(payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 133,
          date: 1713434461,
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
          text: "/help",
          chatId: Number(entry.userId),
          fromId: Number(entry.userId),
          updateId: Number(entry.userId),
        }),
      },
      workerEnv,
    );
    const persistedOrder = await getDatabase(env)
      .prepare(`
        SELECT
          order_id AS orderId,
          current_step AS currentStep,
          status,
          amount_in_cents AS amountInCents,
          wallet_address AS walletAddress
        FROM orders
        WHERE tenant_id = ? AND order_id = ?
        LIMIT 1
      `)
      .bind("beta", entry.orderId)
      .first();
    const count = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE tenant_id = ? AND user_id = ? AND channel = ?")
      .bind("beta", entry.userId, "telegram")
      .first();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(replies[0]).toContain(entry.expectedGuidance);
    expect(replies[0]).toContain("lq1 ou ex1");
    expect(replies[0]).toContain("recomecar");
    expect(persistedOrder?.orderId).toBe(entry.orderId);
    expect(persistedOrder?.currentStep).toBe(entry.currentStep);
    expect(persistedOrder?.status).toBe(entry.status);
    expect(persistedOrder?.amountInCents).toBe(entry.amountInCents);
    expect(persistedOrder?.walletAddress).toBe(entry.walletAddress);
    expect(count?.count).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("answers /status without creating a Telegram order", async function assertStatusWithoutOrderIsReadOnly() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const payload = JSON.parse(String(init?.body));
      replies.push(payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 18,
          date: 1713434419,
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
          text: "/status",
          chatId: 13301,
          fromId: 13301,
          updateId: 13301,
        }),
      },
      workerEnv,
    );
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "13301");
    const count = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE tenant_id = ? AND user_id = ? AND channel = ?")
      .bind("alpha", "13301", "telegram")
      .first();

    expect(response.status).toBe(200);
    expect(currentOrder).toBeNull();
    expect(count?.count).toBe(0);
    expect(replies[0]).toContain("Não encontrei pedido recente em Alpha.");
    expect(replies[0]).toContain("Envie /start");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("answers /status for open and terminal orders scoped to the current Telegram user", async function assertStatusForOrderStates() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const repliesByChatId = new Map();
    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit-status?id=deposit_status_awaiting_payment") {
        return new Response(JSON.stringify({
          qrId: "qr_status_awaiting_payment",
          status: "pending",
          expiration: "2026-04-20T03:00:00.000Z",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      const payload = JSON.parse(String(init?.body));
      repliesByChatId.set(String(payload.chat_id), payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: repliesByChatId.size,
          date: 1713434422,
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
    const statusCases = [
      ["13401", 13401, "order_status_amount", "amount", "draft", null, "Próximo passo: envie o valor em BRL"],
      ["13402", 13402, "order_status_wallet", "wallet", "draft", 1500, "envie seu endereço DePix/Liquid"],
      ["13403", 13403, "order_status_confirmation", "confirmation", "draft", 1500, "toque em Confirmar"],
      ["13404", 13404, "order_status_awaiting_payment", "awaiting_payment", "pending", 1500, "Seu Pix já foi gerado"],
      ["13405", 13405, "order_status_completed", "completed", "paid", 1500, "Pagamento concluído"],
      ["13406", 13406, "order_status_failed", "failed", "failed", 1500, "Este pedido falhou"],
      ["13407", 13407, "order_status_canceled", "canceled", "canceled", 1500, "Este pedido foi cancelado"],
      ["13408", 13408, "order_status_manual_review", "manual_review", "under_review", 1500, "análise operacional"],
    ];

    for (const [userId, chatId, orderId, currentStep, status, amountInCents] of statusCases) {
      await createOrder(getDatabase(env), {
        tenantId: "alpha",
        orderId,
        userId,
        channel: "telegram",
        productType: "depix",
        telegramChatId: String(chatId),
        amountInCents,
        currentStep,
        status,
      });
    }

    await createDeposit(getDatabase(env), {
      tenantId: "alpha",
      depositEntryId: "deposit_status_awaiting_payment",
      qrId: "qr_status_awaiting_payment",
      orderId: "order_status_awaiting_payment",
      nonce: "nonce_status_awaiting_payment",
      qrCopyPaste: "0002010102122688pix-status-awaiting-payment",
      qrImageUrl: "https://example.com/status-qr.png",
      externalStatus: "pending",
      expiration: "2026-04-20T03:00:00.000Z",
    });

    for (const [userId, chatId] of statusCases) {
      await app.request(
        "https://example.com/telegram/alpha/webhook",
        {
          method: "POST",
          headers: requestHeaders,
          body: createTelegramTextUpdate({
            text: "/status",
            chatId,
            fromId: Number(userId),
            updateId: chatId,
          }),
        },
        workerEnv,
      );
    }

    for (const [, chatId, orderId, currentStep, status, , expected] of statusCases) {
      const reply = repliesByChatId.get(String(chatId));
      const savedOrder = await getDatabase(env)
        .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
        .bind("alpha", orderId)
        .first();

      expect(reply).toContain("Status do seu pedido em Alpha.");
      expect(reply).toContain(expected);
      expect(savedOrder).toEqual({
        currentStep,
        status,
      });
    }

    expect(repliesByChatId.get("13404")).not.toContain("Pix copia e cola:");
    expect(repliesByChatId.get("13404")).not.toContain("0002010102122688pix-status-awaiting-payment");
  });

  it("rechecks an awaiting payment order before answering /status", async function assertStatusRechecksAwaitingPaymentOrder() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockRecheckAndTelegram(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit-status?id=deposit_status_recheck_001") {
        return new Response(JSON.stringify({
          qrId: "qr_status_recheck_001",
          status: "depix_sent",
          expiration: "2026-04-20T03:00:00.000Z",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        replies.push(payload.text);

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: replies.length,
            date: 1713434423,
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
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_status_recheck_001",
      userId: "13409",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "13409",
      amountInCents: 500,
      currentStep: "awaiting_payment",
      status: "pending",
    });
    await createDeposit(getDatabase(env), {
      tenantId: "alpha",
      depositEntryId: "deposit_status_recheck_001",
      qrId: "qr_status_recheck_001",
      orderId: "order_status_recheck_001",
      nonce: "nonce_status_recheck_001",
      qrCopyPaste: "0002010102122688pix-status-recheck",
      qrImageUrl: "https://example.com/status-recheck.png",
      externalStatus: "pending",
      expiration: "2026-04-20T03:00:00.000Z",
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
          text: "/status",
          chatId: 13409,
          fromId: 13409,
          updateId: 13409,
        }),
      },
      workerEnv,
    );
    const savedOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_status_recheck_001")
      .first();

    expect(response.status).toBe(200);
    expect(savedOrder).toEqual({
      currentStep: "completed",
      status: "paid",
    });
    expect(replies[0]).toContain("Pagamento concluído");
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("/deposit-status"))).toHaveLength(1);
  });

  it("rechecks an awaiting payment order before answering /start", async function assertStartRechecksAwaitingPaymentOrder() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockRecheckAndTelegram(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit-status?id=deposit_start_recheck_001") {
        return new Response(JSON.stringify({
          qrId: "qr_start_recheck_001",
          status: "depix_sent",
          expiration: "2026-04-20T03:00:00.000Z",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        replies.push(payload.text);

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: replies.length,
            date: 1713434424,
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
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_start_recheck_001",
      userId: "13410",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "13410",
      amountInCents: 500,
      currentStep: "awaiting_payment",
      status: "pending",
    });
    await createDeposit(getDatabase(env), {
      tenantId: "alpha",
      depositEntryId: "deposit_start_recheck_001",
      qrId: "qr_start_recheck_001",
      orderId: "order_start_recheck_001",
      nonce: "nonce_start_recheck_001",
      qrCopyPaste: "0002010102122688pix-start-recheck",
      qrImageUrl: "https://example.com/start-recheck.png",
      externalStatus: "pending",
      expiration: "2026-04-20T03:00:00.000Z",
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
          chatId: 13410,
          fromId: 13410,
          updateId: 13410,
        }),
      },
      workerEnv,
    );
    const savedOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_start_recheck_001")
      .first();
    const orderCount = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE tenant_id = ? AND user_id = ?")
      .bind("alpha", "13410")
      .first();

    expect(response.status).toBe(200);
    expect(savedOrder).toEqual({
      currentStep: "completed",
      status: "paid",
    });
    expect(orderCount?.count).toBe(1);
    expect(replies[0]).toContain("Pagamento concluído");
    expect(replies[0]).not.toContain("aguardando pagamento");
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("/deposit-status"))).toHaveLength(1);
  });

  it("answers /start for a pending payment without resending the QR", async function assertStartForPendingPaymentDoesNotResendQr() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const telegramCalls = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockPendingStart(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit-status?id=deposit_start_pending_001") {
        return new Response(JSON.stringify({
          qrId: "qr_start_pending_001",
          status: "pending",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      const payload = JSON.parse(String(init?.body));
      telegramCalls.push({
        url,
        payload,
      });

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: telegramCalls.length,
          date: 1713434425,
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

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_start_pending_001",
      userId: "13411",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "13411",
      amountInCents: 300,
      currentStep: "awaiting_payment",
      status: "pending",
      telegramCanonicalMessageId: 88,
      telegramCanonicalMessageKind: "photo",
    });
    await createDeposit(getDatabase(env), {
      tenantId: "alpha",
      depositEntryId: "deposit_start_pending_001",
      qrId: "qr_start_pending_001",
      orderId: "order_start_pending_001",
      nonce: "nonce_start_pending_001",
      qrCopyPaste: "0002010102122688pix-start-pending",
      qrImageUrl: "https://example.com/start-pending.png",
      externalStatus: "pending",
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
          chatId: 13411,
          fromId: 13411,
          updateId: 13411,
        }),
      },
      workerEnv,
    );

    expect(response.status).toBe(200);
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].url).toContain("/sendMessage");
    expect(telegramCalls[0].url).not.toContain("/sendPhoto");
    expect(telegramCalls[0].payload.text).toContain("Você tem um pagamento em aberto em Alpha.");
    expect(telegramCalls[0].payload.text).toContain("Toque em Ver status");
    expect(telegramCalls[0].payload.text).not.toContain("0002010102122688pix-start-pending");
    expect(telegramCalls[0].payload.reply_markup?.inline_keyboard).toEqual([
      [
        {
          text: "Ver status",
          callback_data: "depix:status",
        },
        {
          text: "Cancelar pedido",
          callback_data: "depix:cancel",
        },
      ],
    ]);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("/deposit-status"))).toHaveLength(1);
  });

  it("routes plain text replies by tenant", async function assertTenantAwareTextReply() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot654321:beta-test-token/sendMessage");
      expect(payload.chat_id).toBe(2002);
      expect(payload.text).toBe(buildTelegramInvalidAmountReply({
        ok: false,
        reason: "invalid_format",
        minAmountInCents: MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
        maxAmountInCents: 1000000,
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

    const savedOrder = await getLatestOpenOrderByUser(getDatabase(env), "beta", "502");

    expect(savedOrder?.currentStep).toBe("amount");
    expect(savedOrder?.amountInCents).toBeNull();
  });

  it("reuses the same open order when the same tenant user sends a follow-up text", async function assertOpenOrderContinuation() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      if (url.includes("/sendMessage")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 9,
            date: 1713434410,
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
      }

      throw new Error(`Unexpected Telegram API call: ${url}`);
    });

    const workerEnv = createWorkerEnv();

    const startResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 7007,
          fromId: 701,
          updateId: 21,
        }),
      },
      workerEnv,
    );

    const firstOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "701");

    expect(firstOrder?.orderId).toBeTruthy();

    const resumeResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "quero continuar",
          chatId: 7007,
          fromId: 701,
          updateId: 22,
        }),
      },
      workerEnv,
    );

    const resumedOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "701");

    expect(resumedOrder?.orderId).toBe(firstOrder?.orderId);
    expect(resumedOrder?.currentStep).toBe("amount");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("treats /iniciar as an alias of /start", async function assertStartAlias() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");
      expect(payload.text).toContain("Olá! Este é o bot Alpha e te ajudarei a comprar DePix.");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 10,
          date: 1713434411,
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
          text: "/iniciar",
          chatId: 7017,
          fromId: 717,
          updateId: 23,
        }),
      },
      createWorkerEnv(),
    );
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "717");

    expect(response.status).toBe(200);
    expect(currentOrder?.currentStep).toBe("amount");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stores a valid BRL amount and ignores stale valid amount replay after wallet", async function assertAmountCollection() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 10,
          date: 1713434411,
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
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };

    const cancelResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 8101,
          fromId: 811,
          updateId: 41,
        }),
      },
      workerEnv,
    );
    const amountResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "R$ 10",
          chatId: 8101,
          fromId: 811,
          updateId: 42,
        }),
      },
      workerEnv,
    );

    const staleAmountResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "R$ 99",
          chatId: 8101,
          fromId: 811,
          updateId: 43,
        }),
      },
      workerEnv,
    );

    const updatedOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "811");
    const secondReply = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    const thirdReply = JSON.parse(String(fetchSpy.mock.calls[2][1]?.body));

    expect(updatedOrder?.currentStep).toBe("wallet");
    expect(updatedOrder?.status).toBe("draft");
    expect(updatedOrder?.amountInCents).toBe(1000);
    expect(secondReply.text).toContain("Valor recebido: R$ 10.");
    expect(secondReply.text).toContain("Agora envie seu endereço DePix/Liquid.");
    expect(secondReply.text).toContain("Aceito endereços que comecem com lq1 ou ex1.");
    expect(Array.isArray(secondReply.entities)).toBe(true);
    expect(secondReply.entities.length).toBeGreaterThan(0);
    expect(thirdReply.text).toContain("Não reconheci esse endereço.");
    expect(thirdReply.text).toContain("começando com lq1 ou ex1");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps the order in amount when the BRL amount is invalid", async function assertInvalidAmountStaysInAmount() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot654321:beta-test-token/sendMessage");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 10,
          date: 1713434411,
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
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "beta-telegram-secret",
    };

    await app.request(
      "https://example.com/telegram/beta/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 8202,
          fromId: 822,
          updateId: 43,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/beta/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "10,50",
          chatId: 8202,
          fromId: 822,
          updateId: 44,
        }),
      },
      workerEnv,
    );

    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "beta", "822");
    const secondReply = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));

    expect(currentOrder?.currentStep).toBe("amount");
    expect(currentOrder?.amountInCents).toBeNull();
    expect(secondReply.text).toContain("Não aceito pagamento com centavos.");
    expect(secondReply.text).toContain("valor inteiro em reais");
    expect(secondReply.text).toContain("Mínimo:");
    expect(Array.isArray(secondReply.entities)).toBe(true);
    expect(secondReply.entities.length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stores a normalized wallet address and advances the order to confirmation", async function assertWalletCollection() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 12,
          date: 1713434413,
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
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 8303,
          fromId: 833,
          updateId: 45,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "R$ 10",
          chatId: 8303,
          fromId: 833,
          updateId: 46,
        }),
      },
      workerEnv,
    );

    const cancelResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: GROUPED_SIDESWAP_LQ_ADDRESS,
          chatId: 8303,
          fromId: 833,
          updateId: 47,
        }),
      },
      workerEnv,
    );

    const confirmedOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "833");
    const thirdReply = JSON.parse(String(fetchSpy.mock.calls[2][1]?.body));

    expect(confirmedOrder?.currentStep).toBe("confirmation");
    expect(confirmedOrder?.status).toBe("draft");
    expect(confirmedOrder?.amountInCents).toBe(1000);
    expect(confirmedOrder?.walletAddress).toBe(SIDESWAP_LQ_ADDRESS);
    expect(thirdReply.text).toContain("Revise seu pedido:");
    expect(thirdReply.text).toContain("Valor: R$ 10");
    expect(thirdReply.text).toContain(`Endereço:\n${SIDESWAP_LQ_ADDRESS}`);
    expect(thirdReply.text).toContain("Toque em Confirmar.");
    expect(thirdReply.text).toContain("Para encerrar este pedido, toque em Cancelar.");
    expect(thirdReply.text).not.toContain("sim, confirmar ou ok");
    expect(thirdReply.text).not.toContain("envie: cancelar");
    expect(thirdReply.text).toMatch(/Revise seu pedido:\n\nValor: R\$ 10\n\nEndereço:\n/);
    expect(Array.isArray(thirdReply.entities)).toBe(true);
    expect(thirdReply.entities.length).toBeGreaterThan(0);
    expect(thirdReply.reply_markup?.inline_keyboard).toEqual([
      [
        {
          text: "Confirmar",
          callback_data: "depix:confirm",
        },
        {
          text: "Cancelar",
          callback_data: "depix:cancel",
        },
      ],
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps the order in wallet when the wallet address is invalid", async function assertInvalidWalletStaysInWallet() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    await createOrder(getDatabase(env), {
      tenantId: "beta",
      orderId: "order_invalid_wallet",
      userId: "844",
      channel: "telegram",
      productType: "depix",
      amountInCents: 2500,
      currentStep: "wallet",
      status: "draft",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot654321:beta-test-token/sendMessage");
      expect(payload.text).toContain("Não reconheci esse endereço.");
      expect(payload.text).toContain("começando com lq1 ou ex1");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 13,
          date: 1713434414,
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
          text: "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
          chatId: 8404,
          fromId: 844,
          updateId: 48,
        }),
      },
      workerEnv,
    );
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "beta", "844");

    expect(response.status).toBe(200);
    expect(currentOrder?.currentStep).toBe("wallet");
    expect(currentOrder?.walletAddress).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      currentStep: "amount",
      amountInCents: null,
      walletAddress: null,
    },
    {
      currentStep: "wallet",
      amountInCents: 1000,
      walletAddress: null,
    },
    {
      currentStep: "confirmation",
      amountInCents: 1000,
      walletAddress: SIDESWAP_LQ_ADDRESS,
    },
    {
      currentStep: "awaiting_payment",
      amountInCents: 1000,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      status: "pending",
    },
  ])("cancels an open order from $currentStep via /cancel", async function assertCancelableStates(entry) {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const orderId = `order_cancel_${entry.currentStep}`;
    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId,
      userId: "866",
      channel: "telegram",
      productType: "depix",
      amountInCents: entry.amountInCents,
      walletAddress: entry.walletAddress,
      currentStep: entry.currentStep,
      status: entry.status ?? "draft",
      telegramCanonicalMessageId: entry.currentStep === "awaiting_payment" ? 14 : null,
      telegramCanonicalMessageKind: entry.currentStep === "awaiting_payment" ? "photo" : null,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");
      expect(url).not.toContain("/sendPhoto");
      expect(payload.text).toContain("Pedido cancelado com sucesso.");
      expect(payload.text).not.toContain("Pix copia e cola");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 14,
          date: 1713434415,
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
          text: "/cancel",
          chatId: 8606,
          fromId: 866,
          updateId: 49,
        }),
      },
      workerEnv,
    );
    const canceledOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", orderId)
      .first();
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "866");

    expect(response.status).toBe(200);
    expect(canceledOrder?.currentStep).toBe("canceled");
    expect(canceledOrder?.status).toBe("canceled");
    expect(currentOrder).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("creates a new order on /start after a previous order was canceled", async function assertStartAfterCancelCreatesNewOrder() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_cancel_then_restart",
      userId: "877",
      channel: "telegram",
      productType: "depix",
      amountInCents: 1000,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      currentStep: "confirmation",
      status: "draft",
    });
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const payload = JSON.parse(String(init?.body));
      replies.push(payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 15,
          date: 1713434416,
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

    const cancelResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "/cancel",
          chatId: 8707,
          fromId: 877,
          updateId: 50,
        }),
      },
      workerEnv,
    );
    await cancelResponse.text();

    const restartResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 8707,
          fromId: 877,
          updateId: 51,
        }),
      },
      workerEnv,
    );

    const canceledOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_cancel_then_restart")
      .first();
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "877");

    expect(canceledOrder?.currentStep).toBe("canceled");
    expect(currentOrder?.orderId).not.toBe("order_cancel_then_restart");
    expect(currentOrder?.currentStep).toBe("amount");
    expect(replies[0]).toContain("Pedido cancelado com sucesso.");
    expect(replies[1]).toContain("Esses são meus comandos:");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("restarts an open order when the user sends recomecar", async function assertRestartControlFlow() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    await createOrder(getDatabase(env), {
      tenantId: "beta",
      orderId: "order_restart_text",
      userId: "888",
      channel: "telegram",
      productType: "depix",
      amountInCents: 5000,
      currentStep: "wallet",
      status: "draft",
    });
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const payload = JSON.parse(String(init?.body));
      replies.push(payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 16,
          date: 1713434417,
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
          text: "recomecar",
          chatId: 8808,
          fromId: 888,
          updateId: 52,
        }),
      },
      workerEnv,
    );
    const canceledOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("beta", "order_restart_text")
      .first();
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "beta", "888");

    expect(response.status).toBe(200);
    expect(canceledOrder?.currentStep).toBe("canceled");
    expect(currentOrder?.orderId).not.toBe("order_restart_text");
    expect(currentOrder?.currentStep).toBe("amount");
    expect(replies[0]).toContain("Pedido anterior cancelado.");
    expect(replies[0]).toContain("Vamos recomeçar do início.");
    expect(replies[0]).toContain("Esses são meus comandos:");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not create a new order when cancel/restart arrives without an open order", async function assertNoOpenOrderControlReplies() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const payload = JSON.parse(String(init?.body));
      replies.push(payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 17,
          date: 1713434418,
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

    const cancelResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "/cancel",
          chatId: 8909,
          fromId: 899,
          updateId: 53,
        }),
      },
      workerEnv,
    );
    await cancelResponse.text();

    const restartResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "recomecar",
          chatId: 8909,
          fromId: 899,
          updateId: 54,
        }),
      },
      workerEnv,
    );
    await restartResponse.text();

    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "899");

    expect(cancelResponse.status).toBe(200);
    expect(restartResponse.status).toBe(200);
    expect(currentOrder).toBeNull();
    expect(replies[0]).toContain("Não existe pedido aberto para cancelar.");
    expect(replies[1]).toContain("Não existe pedido aberto para recomecar.");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not resume terminal or manual-review orders as editable Telegram conversations", async function assertTerminalOrdersStayClosed() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const payload = JSON.parse(String(init?.body));
      replies.push(payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: replies.length,
          date: 1713434419,
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

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_manual_review_closed",
      userId: "901",
      channel: "telegram",
      productType: "depix",
      currentStep: "manual_review",
      status: "under_review",
    });
    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_completed_closed",
      userId: "902",
      channel: "telegram",
      productType: "depix",
      currentStep: "completed",
      status: "paid",
    });
    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_legacy_paid_closed",
      userId: "903",
      channel: "telegram",
      productType: "depix",
      currentStep: "paid",
      status: "paid",
    });

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/cancel",
          chatId: 9001,
          fromId: 901,
          updateId: 55,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "teste",
          chatId: 9001,
          fromId: 901,
          updateId: 56,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 9002,
          fromId: 902,
          updateId: 57,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 9003,
          fromId: 903,
          updateId: 58,
        }),
      },
      workerEnv,
    );

    const manualReviewOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_manual_review_closed")
      .first();
    const completedOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_completed_closed")
      .first();
    const legacyPaidOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_legacy_paid_closed")
      .first();
    const newManualReviewUserOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "901");
    const newCompletedUserOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "902");
    const newLegacyPaidUserOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "903");

    expect(manualReviewOrder).toEqual({
      currentStep: "manual_review",
      status: "under_review",
    });
    expect(completedOrder).toEqual({
      currentStep: "completed",
      status: "paid",
    });
    expect(legacyPaidOrder).toEqual({
      currentStep: "paid",
      status: "paid",
    });
    expect(newManualReviewUserOrder?.orderId).not.toBe("order_manual_review_closed");
    expect(newManualReviewUserOrder?.currentStep).toBe("amount");
    expect(newCompletedUserOrder?.orderId).not.toBe("order_completed_closed");
    expect(newCompletedUserOrder?.currentStep).toBe("amount");
    expect(newLegacyPaidUserOrder?.orderId).not.toBe("order_legacy_paid_closed");
    expect(newLegacyPaidUserOrder?.currentStep).toBe("amount");
    expect(replies[0]).toContain("Não existe pedido aberto para cancelar.");
    expect(replies[1]).toContain("Não consegui validar esse valor.");
    expect(replies[2]).toContain("Esses são meus comandos:");
    expect(replies[3]).toContain("Esses são meus comandos:");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      userId: 931,
      currentStep: "amount",
      amountInCents: null,
      walletAddress: null,
    },
    {
      userId: 932,
      currentStep: "wallet",
      amountInCents: 1000,
      walletAddress: null,
    },
    {
      userId: 933,
      currentStep: "confirmation",
      amountInCents: 1000,
      walletAddress: SIDESWAP_LQ_ADDRESS,
    },
  ])("expires a stale open Telegram order in $currentStep before consuming the next message", async function assertTimedOutConversation(entry) {
    const app = createApp();
    const workerEnv = createWorkerEnv({
      TELEGRAM_OPEN_ORDER_TIMEOUT_MINUTES: "30",
    });
    const replies = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const payload = JSON.parse(String(init?.body));
      replies.push(payload.text);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: replies.length,
          date: 1713434419,
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

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: `order_stale_${entry.currentStep}`,
      userId: String(entry.userId),
      channel: "telegram",
      productType: "depix",
      currentStep: entry.currentStep,
      status: "draft",
      amountInCents: entry.amountInCents,
      walletAddress: entry.walletAddress,
      telegramChatId: `chat_${entry.currentStep}`,
    });
    await getDatabase(env)
      .prepare("UPDATE orders SET updated_at = ? WHERE tenant_id = ? AND order_id = ?")
      .bind("2026-04-21T17:30:00.000Z", "alpha", `order_stale_${entry.currentStep}`)
      .run();

    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "entrada residual",
          chatId: 9123,
          fromId: entry.userId,
          updateId: 930,
        }),
      },
      workerEnv,
    );

    const timedOutOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status AS status FROM orders WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", `order_stale_${entry.currentStep}`)
      .first();
    const replacementOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", String(entry.userId));

    expect(response.status).toBe(200);
    expect(timedOutOrder?.currentStep).toBe("canceled");
    expect(timedOutOrder?.status).toBe("canceled");
    expect(replacementOrder?.orderId).not.toBe(`order_stale_${entry.currentStep}`);
    expect(replacementOrder?.currentStep).toBe("amount");
    expect(replacementOrder?.amountInCents).toBeNull();
    expect(replies[0]).toContain("expirou por inatividade");
    expect(replies[0]).toContain("Esses são meus comandos:");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not create a second Eulen deposit when confirmar is replayed after awaiting_payment", async function assertConfirmationReplayIdempotency() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const telegramCalls = [];
    const eulenCalls = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockConfirmFlow(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        eulenCalls.push(JSON.parse(String(init?.body)));

        return new Response(JSON.stringify({
          response: {
            id: "deposit_entry_alpha_001",
            qrCopyPaste: "0002010102122688pix-alpha-001",
            qrImageUrl: "https://example.com/qr/alpha-001.png",
          },
          async: false,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendPhoto")) {
        const payload = JSON.parse(String(init?.body));
        telegramCalls.push({
          kind: "photo",
          payload,
        });

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 20,
            date: 1713434420,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/editMessageCaption")) {
        const payload = JSON.parse(String(init?.body));
        telegramCalls.push({
          kind: "edit_caption",
          payload,
        });

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

      if (url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramCalls.push({
          kind: "message",
          payload,
        });

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 21,
            date: 1713434421,
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
      }

      throw new Error(`Unexpected URL in confirmation flow: ${url}`);
    });

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 8505,
          fromId: 855,
          updateId: 51,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "10",
          chatId: 8505,
          fromId: 855,
          updateId: 52,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: GROUPED_SIDESWAP_LQ_ADDRESS,
          chatId: 8505,
          fromId: 855,
          updateId: 53,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "confirmar",
          chatId: 8505,
          fromId: 855,
          updateId: 54,
        }),
      },
      workerEnv,
    );

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "confirmar",
          chatId: 8505,
          fromId: 855,
          updateId: 55,
        }),
      },
      workerEnv,
    );

    const finalOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "855");
    const savedDeposit = await getLatestDepositByOrderId(getDatabase(env), "alpha", finalOrder.orderId);
    const persistedDeposits = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM deposits WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", finalOrder.orderId)
      .first();
    const photoReply = telegramCalls.find((entry) => entry.kind === "photo");
    const copyPasteReply = telegramCalls.find((entry) => entry.kind === "message" && entry.payload.text?.includes("Pix copia e cola:"));
    const photoReplies = telegramCalls.filter((entry) => entry.kind === "photo");
    const editReplies = telegramCalls.filter((entry) => entry.kind === "edit_caption");

    expect(eulenCalls).toHaveLength(1);
    expect(eulenCalls[0]).toEqual({
      amountInCents: 1000,
      depixAddress: SIDESWAP_LQ_ADDRESS,
      depixSplitAddress: SIDESWAP_LQ_ADDRESS,
      splitFee: "1.00%",
    });
    expect(finalOrder?.currentStep).toBe("awaiting_payment");
    expect(finalOrder?.status).toBe("pending");
    expect(finalOrder?.splitAddress).toBe(SIDESWAP_LQ_ADDRESS);
    expect(finalOrder?.splitFee).toBe("1.00%");
    expect(finalOrder?.telegramCanonicalMessageId).toBe(20);
    expect(finalOrder?.telegramCanonicalMessageKind).toBe("photo");
    expect(savedDeposit?.depositEntryId).toBe("deposit_entry_alpha_001");
    expect(savedDeposit?.qrCopyPaste).toBe("0002010102122688pix-alpha-001");
    expect(persistedDeposits?.count).toBe(1);
    expect(photoReply?.payload.photo).toBe("https://example.com/qr/alpha-001.png");
    expect(photoReply?.payload.caption).toContain("Pedido em Alpha: aguardando pagamento.");
    expect(photoReply?.payload.caption).toContain("Pix copia e cola:");
    expect(photoReply?.payload.caption).toContain("0002010102122688pix-alpha-001");
    expect(photoReply?.payload.caption).not.toContain("Expiração:");
    expect(photoReply?.payload.reply_markup?.inline_keyboard).toEqual([
      [
        {
          text: "Ver status",
          callback_data: "depix:status",
        },
        {
          text: "Ajuda",
          callback_data: "depix:help",
        },
      ],
    ]);
    expect(copyPasteReply).toBeUndefined();
    expect(editReplies).toHaveLength(0);
    expect(photoReplies).toHaveLength(2);
    expect(photoReplies[1].payload.caption).toContain("Pedido em Alpha: aguardando pagamento.");
    expect(photoReplies[1].payload.caption).toContain("0002010102122688pix-alpha-001");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("reuses an existing local deposit for a confirmation retry without calling Eulen again", async function assertConfirmationRetryUsesExistingDeposit() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const telegramCalls = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockExistingDepositRetry(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        throw new Error("retry with an existing local deposit must not call Eulen create-deposit");
      }

      if (url.includes("/sendPhoto") || url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramCalls.push({
          url,
          payload,
        });

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: telegramCalls.length,
            date: 1713434450,
            text: payload.text,
            chat: {
              id: payload.chat_id ?? 8707,
              type: "private",
            },
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected URL in existing deposit retry flow: ${url}`);
    });

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_confirmation_existing_deposit",
      userId: "877",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "8707",
      amountInCents: 2500,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      currentStep: "confirmation",
      status: "draft",
    });
    await createDeposit(getDatabase(env), {
      tenantId: "alpha",
      depositEntryId: "deposit_existing_retry_001",
      qrId: null,
      orderId: "order_confirmation_existing_deposit",
      nonce: "nonce_existing_retry_001",
      qrCopyPaste: "0002010102122688pix-existing-retry-001",
      qrImageUrl: "https://example.com/qr/existing-retry-001.png",
      externalStatus: "pending",
      expiration: "2026-04-18T06:00:00Z",
    });

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "confirmar",
          chatId: 8707,
          fromId: 877,
          updateId: 71,
        }),
      },
      workerEnv,
    );

    const savedOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status, split_address AS splitAddress, split_fee AS splitFee FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_confirmation_existing_deposit")
      .first();
    const persistedDeposits = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM deposits WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", "order_confirmation_existing_deposit")
      .first();
    const eulenCalls = fetchSpy.mock.calls.filter(([url]) => String(url) === "https://depix.eulen.app/api/deposit");
    const photoReply = telegramCalls.find((entry) => entry.url.includes("/sendPhoto"));
    const copyPasteReply = telegramCalls.find((entry) => entry.payload.text?.includes("Pix copia e cola:"));

    expect(eulenCalls).toHaveLength(0);
    expect(savedOrder).toEqual({
      currentStep: "awaiting_payment",
      status: "pending",
      splitAddress: SIDESWAP_LQ_ADDRESS,
      splitFee: "1.00%",
    });
    expect(persistedDeposits?.count).toBe(1);
    expect(photoReply?.payload.photo).toBe("https://example.com/qr/existing-retry-001.png");
    expect(copyPasteReply).toBeUndefined();
    expect(photoReply?.payload.caption).toContain("0002010102122688pix-existing-retry-001");
  });

  it("fails closed when an existing local deposit loses the order state race", async function assertExistingDepositTerminalConflictFailsClosed() {
    const app = createApp();
    const telegramMessages = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTerminalConflictRecovery(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        throw new Error("terminal conflict recovery must not create another Eulen deposit");
      }

      if (url.includes("/sendPhoto")) {
        throw new Error("terminal conflict recovery must not return a confirmable deposit photo");
      }

      if (url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramMessages.push(payload.text);

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: telegramMessages.length,
            date: 1713434451,
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
      }

      throw new Error(`Unexpected URL in terminal conflict recovery flow: ${url}`);
    });

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_existing_deposit_terminal_conflict",
      userId: "878",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "8708",
      amountInCents: 2500,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      currentStep: "creating_deposit",
      status: "processing",
    });
    await createDeposit(getDatabase(env), {
      tenantId: "alpha",
      depositEntryId: "deposit_terminal_conflict_001",
      qrId: null,
      orderId: "order_existing_deposit_terminal_conflict",
      nonce: "telegram-order:alpha:order_existing_deposit_terminal_conflict",
      qrCopyPaste: "0002010102122688pix-terminal-conflict-001",
      qrImageUrl: "https://example.com/qr/terminal-conflict-001.png",
      externalStatus: "pending",
      expiration: "2026-04-18T06:00:00Z",
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
          text: "confirmar",
          chatId: 8708,
          fromId: 878,
          updateId: 77,
        }),
      },
      createWorkerEnv({
        DB: createAwaitingPaymentConflictDatabase(
          getDatabase(env),
          {
            tenantId: "alpha",
            orderId: "order_existing_deposit_terminal_conflict",
            currentStep: "canceled",
            status: "canceled",
          },
        ),
      }),
    );
    const savedOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_existing_deposit_terminal_conflict")
      .first();
    const persistedDeposits = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM deposits WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", "order_existing_deposit_terminal_conflict")
      .first();

    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "https://depix.eulen.app/api/deposit")).toHaveLength(0);
    expect(savedOrder).toEqual({
      currentStep: "canceled",
      status: "canceled",
    });
    expect(persistedDeposits?.count).toBe(1);
    expect(telegramMessages.join("\n")).toContain("Não consegui criar seu Pix agora.");
    expect(telegramMessages.join("\n")).not.toContain("Pix copia e cola:");
    expect(telegramMessages.join("\n")).not.toContain("0002010102122688pix-terminal-conflict-001");
  });

  it("serializes concurrent confirmations before the Eulen create-deposit call", async function assertConcurrentConfirmationUsesOrderLease() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const eulenCalls = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockConcurrentConfirmation(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        eulenCalls.push(JSON.parse(String(init?.body)));

        return new Response(JSON.stringify({
          response: {
            id: "deposit_concurrent_confirmation_001",
            qrCopyPaste: "0002010102122688pix-concurrent-confirmation-001",
            qrImageUrl: "https://example.com/qr/concurrent-confirmation-001.png",
          },
          async: false,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendPhoto") || url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 50,
            date: 1713434455,
            text: payload.text,
            chat: {
              id: payload.chat_id ?? 8808,
              type: "private",
            },
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected URL in concurrent confirmation flow: ${url}`);
    });

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_concurrent_confirmation",
      userId: "888",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "8808",
      amountInCents: 2500,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      currentStep: "confirmation",
      status: "draft",
    });

    await Promise.all([
      app.request(
        "https://example.com/telegram/alpha/webhook",
        {
          method: "POST",
          headers: requestHeaders,
          body: createTelegramTextUpdate({
            text: "confirmar",
            chatId: 8808,
            fromId: 888,
            updateId: 72,
          }),
        },
        workerEnv,
      ),
      app.request(
        "https://example.com/telegram/alpha/webhook",
        {
          method: "POST",
          headers: requestHeaders,
          body: createTelegramTextUpdate({
            text: "confirmar",
            chatId: 8808,
            fromId: 888,
            updateId: 73,
          }),
        },
        workerEnv,
      ),
    ]);

    const finalOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_concurrent_confirmation")
      .first();
    const persistedDeposits = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM deposits WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", "order_concurrent_confirmation")
      .first();

    expect(eulenCalls).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "https://depix.eulen.app/api/deposit")).toHaveLength(1);
    expect(persistedDeposits?.count).toBe(1);
    expect(finalOrder).toEqual({
      currentStep: "awaiting_payment",
      status: "pending",
    });
  });

  it("keeps creating_deposit retryable when D1 fails after Eulen returns a deposit", async function assertPartialFailureRetryUsesSameNonce() {
    const app = createApp();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const eulenNonces = [];
    const telegramMessages = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockPartialFailureRecovery(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        eulenNonces.push(init?.headers?.get("X-Nonce"));

        return new Response(JSON.stringify({
          response: {
            id: "deposit_partial_recovery_001",
            qrCopyPaste: "0002010102122688pix-partial-recovery-001",
            qrImageUrl: "https://example.com/qr/partial-recovery-001.png",
          },
          async: false,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendPhoto") || url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramMessages.push(payload.caption ?? payload.text);

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: telegramMessages.length,
            date: 1713434457,
            text: payload.text,
            chat: {
              id: payload.chat_id ?? 8810,
              type: "private",
            },
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected URL in partial recovery flow: ${url}`);
    });

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_partial_recovery",
      userId: "890",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "8810",
      amountInCents: 2500,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      currentStep: "confirmation",
      status: "draft",
    });

    const firstResponse = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "confirmar",
          chatId: 8810,
          fromId: 890,
          updateId: 75,
        }),
      },
      createWorkerEnv({
        DB: createOnceFailingBatchDatabase(
          getDatabase(env),
          new Error("injected_d1_deposit_insert_failure"),
        ),
      }),
    );
    const retryableOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_partial_recovery")
      .first();
    const depositsAfterFailure = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM deposits WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", "order_partial_recovery")
      .first();

    expect(firstResponse.status).toBe(200);
    expect(retryableOrder).toEqual({
      currentStep: "creating_deposit",
      status: "processing",
    });
    expect(depositsAfterFailure?.count).toBe(0);
    expect(telegramMessages.at(-1)).toContain("recuperação segura");

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "confirmar",
          chatId: 8810,
          fromId: 890,
          updateId: 76,
        }),
      },
      createWorkerEnv(),
    );

    const finalOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_partial_recovery")
      .first();
    const savedDeposit = await getLatestDepositByOrderId(getDatabase(env), "alpha", "order_partial_recovery");
    const persistedDeposits = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM deposits WHERE tenant_id = ? AND order_id = ?")
      .bind("alpha", "order_partial_recovery")
      .first();

    const expectedNonce = createTelegramOrderDepositNonce({
      tenantId: "alpha",
      orderId: "order_partial_recovery",
    });

    expect(eulenNonces).toEqual([
      expectedNonce,
      expectedNonce,
    ]);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "https://depix.eulen.app/api/deposit")).toHaveLength(2);
    expect(finalOrder).toEqual({
      currentStep: "awaiting_payment",
      status: "pending",
    });
    expect(savedDeposit?.depositEntryId).toBe("deposit_partial_recovery_001");
    expect(savedDeposit?.nonce).toBe(expectedNonce);
    expect(persistedDeposits?.count).toBe(1);
    expect(telegramMessages.some((message) => message?.includes("Pedido em Alpha: aguardando pagamento."))).toBe(true);

    const serializedLogs = consoleSpy.mock.calls.map(([line]) => String(line)).join("\n");

    expect(serializedLogs).toContain("telegram_order_deposit_recovery_retryable");
    expect(serializedLogs).toContain(expectedNonce);
    expect(serializedLogs).not.toContain("0002010102122688pix-partial-recovery-001");
    expect(serializedLogs).not.toContain("alpha-eulen-token");
    expect(serializedLogs).not.toContain("alpha-telegram-secret");
  });

  it("fails closed when a reused local deposit is missing Telegram QR fields", async function assertMalformedExistingDepositFailsClosed() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const telegramMessages = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockMalformedExistingDeposit(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        throw new Error("malformed local deposit recovery must not create another Eulen deposit");
      }

      if (url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramMessages.push(payload.text);

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 51,
            date: 1713434456,
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
      }

      throw new Error(`Unexpected URL in malformed deposit flow: ${url}`);
    });

    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_malformed_existing_deposit",
      userId: "889",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "8809",
      amountInCents: 2500,
      walletAddress: SIDESWAP_LQ_ADDRESS,
      currentStep: "confirmation",
      status: "draft",
    });
    await getDatabase(env)
      .prepare(`INSERT INTO deposits (
        tenant_id,
        deposit_entry_id,
        qr_id,
        order_id,
        nonce,
        qr_copy_paste,
        qr_image_url,
        external_status,
        expiration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        "alpha",
        "deposit_malformed_existing_001",
        null,
        "order_malformed_existing_deposit",
        "nonce_malformed_existing_001",
        "",
        "https://example.com/qr/malformed-existing.png",
        "pending",
        "2026-04-18T06:00:00Z",
      )
      .run();

    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: createTelegramTextUpdate({
          text: "confirmar",
          chatId: 8809,
          fromId: 889,
          updateId: 74,
        }),
      },
      workerEnv,
    );
    const failedOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status FROM orders WHERE tenant_id = ? AND order_id = ? LIMIT 1")
      .bind("alpha", "order_malformed_existing_deposit")
      .first();

    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "https://depix.eulen.app/api/deposit")).toHaveLength(0);
    expect(failedOrder).toEqual({
      currentStep: "failed",
      status: "failed",
    });
    expect(telegramMessages.join("\n")).toContain("Não consegui criar seu Pix agora.");
  });

  it("resolves async Eulen deposit creation before replying to the user", async function assertAsyncConfirmationFlow() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "beta-telegram-secret",
    };
    const telegramCalls = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockAsyncConfirmFlow(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        return new Response(JSON.stringify({
          async: true,
          urlResponse: "https://example.com/eulen-async/beta-001",
          expiration: "2026-04-18T12:00:00.000Z",
        }), {
          status: 202,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url === "https://example.com/eulen-async/beta-001") {
        return new Response(JSON.stringify({
          response: {
            id: "deposit_entry_beta_001",
            qrCopyPaste: "0002010102122688pix-beta-001",
            qrImageUrl: "https://example.com/qr/beta-001.png",
          },
          async: false,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendPhoto") || url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramCalls.push({
          kind: url.includes("/sendPhoto") ? "photo" : "message",
          payload,
        });

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 30,
            date: 1713434430,
            text: payload.text,
            chat: {
              id: payload.chat_id ?? 8606,
              type: "private",
            },
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected URL in async confirmation flow: ${url}`);
    });

    for (const [text, updateId] of [
      ["/start", 61],
      ["10", 62],
      [SIDESWAP_LQ_ADDRESS, 63],
      ["sim", 64],
    ]) {
      await app.request(
        "https://example.com/telegram/beta/webhook",
        {
          method: "POST",
          headers: requestHeaders,
          body: createTelegramTextUpdate({
            text,
            chatId: 8606,
            fromId: 866,
            updateId,
          }),
        },
        workerEnv,
      );
    }

    const finalOrder = await getLatestOpenOrderByUser(getDatabase(env), "beta", "866");
    const savedDeposit = await getLatestDepositByOrderId(getDatabase(env), "beta", finalOrder.orderId);
    const photoReply = telegramCalls.find((entry) => entry.kind === "photo");

    expect(fetchSpy.mock.calls.some(([url]) => String(url) === "https://example.com/eulen-async/beta-001")).toBe(true);
    expect(finalOrder?.currentStep).toBe("awaiting_payment");
    expect(savedDeposit?.depositEntryId).toBe("deposit_entry_beta_001");
    expect(photoReply?.payload.caption).toContain("Expiração: 18/04/2026 12:00 (UTC).");
  });

  it("falls back to plain text when Telegram rejects the QR photo without dropping the copy-paste instructions", async function assertDepositPhotoFallback() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const telegramCalls = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockDepositPhotoFallback(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        return new Response(JSON.stringify({
          response: {
            id: "deposit_entry_alpha_002",
            qrCopyPaste: "0002010102122688pix-alpha-002",
            qrImageUrl: "https://example.com/qr/alpha-002.png",
            expiration: "2026-04-18T12:00:00.000Z",
          },
          async: false,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendPhoto")) {
        return new Response(JSON.stringify({
          ok: false,
          description: "photo rejected",
        }), {
          status: 500,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramCalls.push(payload);

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 50,
            date: 1713434450,
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
      }

      throw new Error(`Unexpected URL in deposit photo fallback flow: ${url}`);
    });

    for (const [text, updateId] of [
      ["/start", 71],
      ["10", 72],
      [SIDESWAP_LQ_ADDRESS, 73],
      ["confirmar", 74],
    ]) {
      await app.request(
        "https://example.com/telegram/alpha/webhook",
        {
          method: "POST",
          headers: requestHeaders,
          body: createTelegramTextUpdate({
            text,
            chatId: 8707,
            fromId: 877,
            updateId,
          }),
        },
        workerEnv,
      );
    }

    const pixReplies = telegramCalls.filter((payload) => (
      payload.text?.includes("Pedido confirmado em Alpha.")
      || payload.text?.includes("Pix copia e cola:")
    ));

    expect(fetchSpy).toHaveBeenCalled();
    expect(pixReplies).toHaveLength(1);
    expect(pixReplies[0]?.text).toContain("Pedido em Alpha: aguardando pagamento.");
    expect(pixReplies[0]?.text).toContain("Expiração: 18/04/2026 12:00 (UTC).");
    expect(pixReplies[0]?.text).toContain("Pix copia e cola:");
    expect(pixReplies[0]?.text).toContain("0002010102122688pix-alpha-002");
  });

  it("marks the order as failed and replies with a restart instruction when Eulen create-deposit fails", async function assertConfirmationFailureFlow() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const telegramMessages = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockFailureFlow(input, init) {
      const url = String(input);

      if (url === "https://depix.eulen.app/api/deposit") {
        return new Response(JSON.stringify({
          error: "upstream failed",
        }), {
          status: 502,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramMessages.push(payload.text);

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 40,
            date: 1713434440,
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
      }

      throw new Error(`Unexpected URL in failed confirmation flow: ${url}`);
    });

    for (const [text, updateId] of [
      ["/start", 71],
      ["10", 72],
      [SIDESWAP_LQ_ADDRESS, 73],
      ["ok", 74],
    ]) {
      await app.request(
        "https://example.com/telegram/alpha/webhook",
        {
          method: "POST",
          headers: requestHeaders,
          body: createTelegramTextUpdate({
            text,
            chatId: 8707,
            fromId: 877,
            updateId,
          }),
        },
        workerEnv,
      );
    }

    const failedOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status AS status FROM orders WHERE tenant_id = ? AND user_id = ? LIMIT 1")
      .bind("alpha", "877")
      .first();

    expect(failedOrder?.currentStep).toBe("failed");
    expect(failedOrder?.status).toBe("failed");
    expect(telegramMessages[telegramMessages.length - 1]).toContain("Não consegui criar seu Pix agora.");
    expect(telegramMessages[telegramMessages.length - 1]).toContain("Envie /start para recomecar");
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "https://depix.eulen.app/api/deposit")).toHaveLength(3);
  });

  it("cancels the order from confirmation when the user sends cancelar", async function assertConfirmationCancellation() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "beta-telegram-secret",
    };
    const telegramMessages = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockCancellationFlow(input, init) {
      const url = String(input);

      if (url.includes("/sendMessage")) {
        const payload = JSON.parse(String(init?.body));
        telegramMessages.push(payload.text);

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 50,
            date: 1713434450,
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
      }

      throw new Error(`Unexpected URL in cancellation flow: ${url}`);
    });

    for (const [text, updateId] of [
      ["/start", 81],
      ["10", 82],
      [SIDESWAP_LQ_ADDRESS, 83],
      ["cancelar", 84],
    ]) {
      await app.request(
        "https://example.com/telegram/beta/webhook",
        {
          method: "POST",
          headers: requestHeaders,
          body: createTelegramTextUpdate({
            text,
            chatId: 8808,
            fromId: 888,
            updateId,
          }),
        },
        workerEnv,
      );
    }

    const canceledOrder = await getDatabase(env)
      .prepare("SELECT current_step AS currentStep, status AS status FROM orders WHERE tenant_id = ? AND user_id = ? LIMIT 1")
      .bind("beta", "888")
      .first();

    expect(canceledOrder?.currentStep).toBe("canceled");
    expect(canceledOrder?.status).toBe("canceled");
    expect(telegramMessages[telegramMessages.length - 1]).toContain("Pedido cancelado com sucesso.");
  });

  it("does not duplicate or regress the order when /start is replayed", async function assertStartReplayIsIdempotent() {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/sendMessage");
      expect(payload.text).toContain("Olá! Este é o bot Alpha e te ajudarei a comprar DePix.");
      expect(payload.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe("Comprar DePix");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 10,
          date: 1713434411,
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
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 8008,
          fromId: 801,
          updateId: 31,
        }),
      },
      workerEnv,
    );
    const firstOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "801");

    await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramTextUpdate({
          text: "/start",
          chatId: 8008,
          fromId: 801,
          updateId: 32,
        }),
      },
      workerEnv,
    );

    const replayedOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "801");
    const count = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE tenant_id = ? AND user_id = ? AND channel = ?")
      .bind("alpha", "801", "telegram")
      .first();

    expect(firstOrder?.orderId).toBeTruthy();
    expect(replayedOrder?.orderId).toBe(firstOrder?.orderId);
    expect(replayedOrder?.telegramChatId).toBe("8008");
    expect(replayedOrder?.currentStep).toBe("amount");
    expect(count?.count).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("answers from the current open step without creating a duplicate order", async function assertExistingStepReply() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    await createOrder(getDatabase(env), {
      tenantId: "beta",
      orderId: "order_existing_wallet",
      userId: "901",
      channel: "telegram",
      productType: "depix",
      amountInCents: 10000,
      currentStep: "wallet",
      status: "draft",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot654321:beta-test-token/sendMessage");
      expect(payload.chat_id).toBe(9009);
      expect(payload.text).toContain("Não reconheci esse endereço.");
      expect(payload.text).toContain("começando com lq1 ou ex1");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 11,
          date: 1713434412,
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
          text: "20",
          chatId: 9009,
          fromId: 901,
          updateId: 33,
        }),
      },
      workerEnv,
    );
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "beta", "901");
    const count = await getDatabase(env)
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE tenant_id = ? AND user_id = ? AND channel = ?")
      .bind("beta", "901", "telegram")
      .first();

    expect(response.status).toBe(200);
    expect(currentOrder?.orderId).toBe("order_existing_wallet");
    expect(currentOrder?.currentStep).toBe("wallet");
    expect(currentOrder?.amountInCents).toBe(10000);
    expect(count?.count).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("hydrates a legacy open order with the current Telegram chat id", async function assertLegacyChatHydration() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    await createOrder(getDatabase(env), {
      tenantId: "alpha",
      orderId: "order_legacy_chat_hydration",
      userId: "912",
      channel: "telegram",
      productType: "depix",
      currentStep: "amount",
      status: "draft",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot123456:alpha-test-token/sendMessage");
      expect(payload.text).toContain("Valor recebido: R$ 10.");
      expect(Array.isArray(payload.entities)).toBe(true);
      expect(payload.entities.length).toBeGreaterThan(0);

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 17,
          date: 1713434418,
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
          text: "10",
          chatId: 9912,
          fromId: 912,
          updateId: 912,
        }),
      },
      workerEnv,
    );
    const hydratedOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "912");

    expect(response.status).toBe(200);
    expect(hydratedOrder?.orderId).toBe("order_legacy_chat_hydration");
    expect(hydratedOrder?.telegramChatId).toBe("9912");
    expect(hydratedOrder?.currentStep).toBe("wallet");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks a divergent Telegram chat without mutating the existing order", async function assertDivergentChatBlocked() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createOrder(getDatabase(env), {
      tenantId: "beta",
      orderId: "order_divergent_chat",
      userId: "913",
      channel: "telegram",
      productType: "depix",
      telegramChatId: "original-chat",
      currentStep: "amount",
      status: "draft",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      expect(url).toContain("/bot654321:beta-test-token/sendMessage");
      expect(payload.text).toContain("Não consigo continuar este pedido por este chat.");

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 18,
          date: 1713434419,
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
          text: "10",
          chatId: 9913,
          fromId: 913,
          updateId: 913,
        }),
      },
      workerEnv,
    );
    const unchangedOrder = await getLatestOpenOrderByUser(getDatabase(env), "beta", "913");
    const logRecords = consoleSpy.mock.calls.map(([entry]) => JSON.parse(entry));
    const divergenceLog = logRecords.find((record) => record.message === "telegram.order.chat_divergence_detected");

    expect(response.status).toBe(200);
    expect(unchangedOrder?.telegramChatId).toBe("original-chat");
    expect(unchangedOrder?.currentStep).toBe("amount");
    expect(unchangedOrder?.amountInCents).toBeNull();
    expect(divergenceLog?.details?.orderId).toBe("order_divergent_chat");
    expect(divergenceLog?.details?.persistedTelegramChatId).toBe("original-chat");
    expect(divergenceLog?.details?.incomingTelegramChatId).toBe("9913");
    expect(divergenceLog?.details?.reason).toBe("telegram_chat_id_mismatch");
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
    const currentOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "503");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(currentOrder).toBeNull();
    expect(logRecords.some((record) => record.details?.handlerName === "unsupported_update_reply")).toBe(true);
  });

  it("answers the initial Comprar DePix CTA with the amount instruction", async function assertBuyCallbackPrompt() {
    const app = createApp();
    const telegramCalls = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockTelegramFetch(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      telegramCalls.push({
        kind: url.includes("/answerCallbackQuery") ? "callback" : "message",
        payload,
      });

      return new Response(JSON.stringify({
        ok: true,
        result: url.includes("/answerCallbackQuery")
          ? true
          : {
            message_id: 31,
            date: 1713434431,
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
        body: createTelegramCallbackQueryUpdate({
          chatId: 3004,
          fromId: 504,
          updateId: 4,
          data: "depix:buy",
        }),
      },
      createWorkerEnv(),
    );

    expect(response.status).toBe(200);
    expect(telegramCalls).toHaveLength(2);
    expect(telegramCalls[0]).toMatchObject({
      kind: "callback",
      payload: {
        callback_query_id: "callback-4",
        text: "Envie o valor da compra.",
      },
    });
    expect(telegramCalls[1].kind).toBe("message");
    expect(telegramCalls[1].payload.text).toContain("Para comprar DePix, envie o valor em BRL.");
    expect(telegramCalls[1].payload.text).not.toContain("inteiro");
    expect(telegramCalls[1].payload.text).toContain("Exemplo: 100");
  });

  it("confirms the order from confirmation when the user presses the inline CTA", async function assertInlineConfirmationFlow() {
    const app = createApp();
    const workerEnv = createWorkerEnv();
    const requestHeaders = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
    };
    const telegramCalls = [];
    const eulenCalls = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async function mockInlineConfirmation(input, init) {
      const url = String(input);
      const payload = JSON.parse(String(init?.body));

      if (url === "https://depix.eulen.app/api/deposit") {
        eulenCalls.push(payload);

        return new Response(JSON.stringify({
          response: {
            id: "deposit_entry_alpha_inline_001",
            qrCopyPaste: "0002010102122688pix-alpha-inline-001",
            qrImageUrl: "https://example.com/qr/alpha-inline-001.png",
            expiration: null,
          },
          async: false,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/answerCallbackQuery")) {
        telegramCalls.push({
          kind: "callback",
          payload,
        });

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

      if (url.includes("/sendPhoto") || url.includes("/sendMessage")) {
        telegramCalls.push({
          kind: url.includes("/sendPhoto") ? "photo" : "message",
          payload,
        });

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 61,
            date: 1713434461,
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
      }

      throw new Error(`Unexpected URL in inline confirmation flow: ${url}`);
    });

    for (const [text, updateId] of [
      ["/start", 501],
      ["10", 502],
      [SIDESWAP_LQ_ADDRESS, 503],
    ]) {
      await app.request(
        "https://example.com/telegram/alpha/webhook",
        {
          method: "POST",
          headers: requestHeaders,
          body: createTelegramTextUpdate({
            text,
            chatId: 9505,
            fromId: 955,
            updateId,
          }),
        },
        workerEnv,
      );
    }

    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: requestHeaders,
        body: createTelegramCallbackQueryUpdate({
          chatId: 9505,
          fromId: 955,
          updateId: 504,
          data: "depix:confirm",
        }),
      },
      workerEnv,
    );

    const finalOrder = await getLatestOpenOrderByUser(getDatabase(env), "alpha", "955");
    const callbackReply = telegramCalls.find((entry) => entry.kind === "callback");
    const photoReply = telegramCalls.find((entry) => entry.kind === "photo");

    expect(response.status).toBe(200);
    expect(eulenCalls).toHaveLength(1);
    expect(callbackReply?.payload.text).toBe("Confirmando pedido.");
    expect(finalOrder?.currentStep).toBe("awaiting_payment");
    expect(finalOrder?.status).toBe("pending");
    expect(photoReply?.payload.reply_markup?.inline_keyboard).toEqual([
      [
        {
          text: "Ver status",
          callback_data: "depix:status",
        },
        {
          text: "Ajuda",
          callback_data: "depix:help",
        },
      ],
    ]);
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

  it("fails closed with a structured error when the inbound update shape is invalid", async function assertStructuredInvalidPayloadError() {
    const app = createApp();
    const response = await app.request(
      "https://example.com/telegram/alpha/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "alpha-telegram-secret",
        },
        body: JSON.stringify({
          update_id: 9,
          message: {
            message_id: 12,
            text: "/start",
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
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_webhook_payload");
    expect(payload.error.details).toMatchObject({
      code: "telegram_invalid_payload",
      source: "telegram",
      reason: "telegram_chat_missing",
      field: "message.chat",
      updateType: "message",
    });
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
