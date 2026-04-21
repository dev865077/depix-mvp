import { Bot, webhookCallback } from "grammy";

import { installTelegramReplyFlow } from "./reply-flow.js";
import type {
  TelegramBootstrapBotInfo,
  TelegramRuntime,
  TelegramTenantConfig,
  TelegramWebhookCallbackInput,
} from "./types.js";

const telegramRuntimeCache = new Map<string, TelegramRuntime>();

function buildBootstrapUsername(tenantId: string): string {
  const normalizedTenantId = tenantId
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `${normalizedTenantId || "tenant"}_bootstrap_bot`;
}

function buildBootstrapBotInfo(tenantConfig: Pick<TelegramTenantConfig, "tenantId" | "displayName">): TelegramBootstrapBotInfo {
  return {
    id: 0,
    is_bot: true,
    first_name: `${tenantConfig.displayName} Runtime`,
    username: buildBootstrapUsername(tenantConfig.tenantId),
    can_join_groups: true,
    can_manage_bots: false,
    can_connect_to_business: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  };
}

export function createTelegramBot(
  tenantConfig: Pick<TelegramTenantConfig, "tenantId" | "displayName">,
  telegramBotToken: string,
  options = {},
): Bot {
  const bot = new Bot(telegramBotToken, {
    botInfo: buildBootstrapBotInfo(tenantConfig),
  });

  installTelegramReplyFlow(bot, {
    tenant: tenantConfig,
    ...options,
  });

  return bot;
}

export function createTelegramRuntime(tenantConfig: TelegramTenantConfig): TelegramRuntime {
  const botInfo = buildBootstrapBotInfo(tenantConfig);

  return {
    engine: "grammy",
    tenantId: tenantConfig.tenantId,
    botInfo,
    createBot(telegramBotToken, options) {
      return createTelegramBot(tenantConfig, telegramBotToken, options);
    },
    createWebhookCallback(input: TelegramWebhookCallbackInput) {
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

export function getTelegramRuntime(tenantConfig: TelegramTenantConfig): TelegramRuntime {
  const cachedRuntime = telegramRuntimeCache.get(tenantConfig.tenantId);

  if (cachedRuntime) {
    return cachedRuntime;
  }

  const runtime = createTelegramRuntime(tenantConfig);

  telegramRuntimeCache.set(tenantConfig.tenantId, runtime);

  return runtime;
}

export function listBootstrappedTelegramTenants(): string[] {
  return [...telegramRuntimeCache.keys()].sort();
}

export function clearTelegramRuntimeCache(): void {
  telegramRuntimeCache.clear();
}
