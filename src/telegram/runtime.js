/**
 * Bootstrap e cache do runtime Telegram baseado em grammY.
 *
 * A responsabilidade deste modulo e:
 * - bootstrapar o runtime por tenant
 * - instalar o fluxo minimo de resposta do bot
 * - manter a fronteira explicita entre rota HTTP e comportamento do bot
 */
import { Bot, webhookCallback } from "grammy";

import { installTelegramReplyFlow } from "./reply-flow.js";

const telegramRuntimeCache = new Map();

/**
 * Gera um username sintetico seguro para o bot bootstrapado.
 *
 * O tenantId pode ganhar hifens ou outros caracteres operacionais ao longo do
 * tempo. Como o `botInfo.username` deve continuar parecendo um username valido
 * do Telegram, normalizamos a string para manter apenas caracteres seguros.
 *
 * @param {string} tenantId Identificador interno do tenant.
 * @returns {string} Username sintetico e estavel para o bootstrap.
 */
function buildBootstrapUsername(tenantId) {
  const normalizedTenantId = tenantId
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `${normalizedTenantId || "tenant"}_bootstrap_bot`;
}

/**
 * Monta um botInfo sintetico para o bootstrap do grammY.
 *
 * O runtime roda em ambiente serverless e nao deve depender de `getMe()` para
 * cada request. Por isso, deixamos um `botInfo` estavel no bootstrap.
 *
 * @param {{ tenantId: string, displayName: string }} tenantConfig Tenant atual.
 * @returns {{ id: number, is_bot: true, first_name: string, username: string, can_join_groups: boolean, can_read_all_group_messages: false, supports_inline_queries: false }} Identidade sintetica do bot.
 */
function buildBootstrapBotInfo(tenantConfig) {
  return {
    id: 0,
    is_bot: true,
    first_name: `${tenantConfig.displayName} Runtime`,
    username: buildBootstrapUsername(tenantConfig.tenantId),
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
}

/**
 * Cria um bot grammY real para o tenant.
 *
 * @param {{ tenantId: string, displayName: string }} tenantConfig Tenant resolvido.
 * @param {string} telegramBotToken Token real do bot no Telegram.
 * @param {{
 *   env?: Record<string, unknown>,
 *   runtimeConfig?: Record<string, unknown>,
 *   db?: import("@cloudflare/workers-types").D1Database,
 *   rawTelegramUpdate?: { chatId?: string, parseFailed: boolean },
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} [options] Instrumentacao do request atual.
 * @returns {Bot} Instancia do bot pronta para uso futuro.
 */
export function createTelegramBot(tenantConfig, telegramBotToken, options = {}) {
  const bot = new Bot(telegramBotToken, {
    botInfo: buildBootstrapBotInfo(tenantConfig),
  });

  installTelegramReplyFlow(bot, {
    tenant: tenantConfig,
    env: options.env,
    runtimeConfig: options.runtimeConfig,
    db: options.db,
    rawTelegramUpdate: options.rawTelegramUpdate,
    requestContext: options.requestContext,
  });

  return bot;
}

/**
 * Cria a estrutura de runtime do Telegram para um tenant especifico.
 *
 * @param {{ tenantId: string, displayName: string, secretBindings: Record<string, string> }} tenantConfig Tenant resolvido.
 * @returns {{
 *   engine: "grammy",
 *   tenantId: string,
 *   botInfo: ReturnType<typeof buildBootstrapBotInfo>,
 *   createBot: (
 *     telegramBotToken: string,
 *     options?: {
 *       runtimeConfig?: Record<string, unknown>,
 *       db?: import("@cloudflare/workers-types").D1Database,
 *       rawTelegramUpdate?: { chatId?: string, parseFailed: boolean },
 *       requestContext?: {
 *         requestId?: string,
 *         method?: string,
 *         path?: string
 *       }
 *     }
 *   ) => Bot,
 *   createWebhookCallback: (
 *     input:
 *       | string
 *       | {
 *           telegramBotToken: string,
 *           telegramWebhookSecret?: string,
 *           env?: Record<string, unknown>,
 *           runtimeConfig?: Record<string, unknown>,
 *           db?: import("@cloudflare/workers-types").D1Database,
 *           rawTelegramUpdate?: { chatId?: string, parseFailed: boolean },
 *           requestContext?: {
 *             requestId?: string,
 *             method?: string,
 *             path?: string
 *           }
 *         }
 *   ) => (request: Request) => Promise<Response>
 * }} Runtime pronto para ser reutilizado.
 */
export function createTelegramRuntime(tenantConfig) {
  const botInfo = buildBootstrapBotInfo(tenantConfig);

  return {
    engine: "grammy",
    tenantId: tenantConfig.tenantId,
    botInfo,
    createBot(telegramBotToken, options) {
      return createTelegramBot(tenantConfig, telegramBotToken, options);
    },
    createWebhookCallback(input) {
      const options = typeof input === "string"
        ? { telegramBotToken: input }
        : input;
      const bot = createTelegramBot(tenantConfig, options.telegramBotToken, {
        env: options.env,
        runtimeConfig: options.runtimeConfig,
        db: options.db,
        rawTelegramUpdate: options.rawTelegramUpdate,
        requestContext: options.requestContext,
      });

      return webhookCallback(bot, "cloudflare-mod", {
        secretToken: options.telegramWebhookSecret,
      });
    },
  };
}

/**
 * Devolve o runtime do tenant, reaproveitando a instancia quando ela ja foi
 * criada anteriormente dentro do processo atual do Worker.
 *
 * @param {{ tenantId: string, displayName: string, secretBindings: Record<string, string> }} tenantConfig Tenant resolvido.
 * @returns {{
 *   engine: "grammy",
 *   tenantId: string,
 *   botInfo: ReturnType<typeof buildBootstrapBotInfo>,
 *   createBot: (
 *     telegramBotToken: string,
 *     options?: {
 *       runtimeConfig?: Record<string, unknown>,
 *       db?: import("@cloudflare/workers-types").D1Database,
 *       rawTelegramUpdate?: { chatId?: string, parseFailed: boolean },
 *       requestContext?: {
 *         requestId?: string,
 *         method?: string,
 *         path?: string
 *       }
 *     }
 *   ) => Bot,
 *   createWebhookCallback: (
 *     input:
 *       | string
 *       | {
 *           telegramBotToken: string,
 *           telegramWebhookSecret?: string,
 *           runtimeConfig?: Record<string, unknown>,
 *           db?: import("@cloudflare/workers-types").D1Database,
 *           rawTelegramUpdate?: { chatId?: string, parseFailed: boolean },
 *           requestContext?: {
 *             requestId?: string,
 *             method?: string,
 *             path?: string
 *           }
 *         }
 *   ) => (request: Request) => Promise<Response>
 * }} Runtime do tenant.
 */
export function getTelegramRuntime(tenantConfig) {
  const cachedRuntime = telegramRuntimeCache.get(tenantConfig.tenantId);

  if (cachedRuntime) {
    return cachedRuntime;
  }

  const runtime = createTelegramRuntime(tenantConfig);

  telegramRuntimeCache.set(tenantConfig.tenantId, runtime);

  return runtime;
}

/**
 * Lista os tenants cujo runtime ja foi materializado no processo atual.
 *
 * @returns {string[]} Tenants com runtime bootstrapado.
 */
export function listBootstrappedTelegramTenants() {
  return [...telegramRuntimeCache.keys()].sort();
}

/**
 * Limpa o cache do runtime Telegram.
 *
 * Esta funcao existe para testes e para eventuais rotinas futuras de reset
 * controlado.
 */
export function clearTelegramRuntimeCache() {
  telegramRuntimeCache.clear();
}
