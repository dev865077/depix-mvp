import { Bot, webhookCallback } from "grammy";
import { installTelegramReplyFlow } from "./reply-flow.js";
const telegramRuntimeCache = new Map();
function buildBootstrapUsername(tenantId) {
    const normalizedTenantId = tenantId
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return `${normalizedTenantId || "tenant"}_bootstrap_bot`;
}
function buildBootstrapBotInfo(tenantConfig) {
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
export function createTelegramBot(tenantConfig, telegramBotToken, options = {}) {
    const bot = new Bot(telegramBotToken, {
        botInfo: buildBootstrapBotInfo(tenantConfig),
    });
    installTelegramReplyFlow(bot, {
        tenant: tenantConfig,
        ...options,
    });
    return bot;
}
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
export function getTelegramRuntime(tenantConfig) {
    const cachedRuntime = telegramRuntimeCache.get(tenantConfig.tenantId);
    if (cachedRuntime) {
        return cachedRuntime;
    }
    const runtime = createTelegramRuntime(tenantConfig);
    telegramRuntimeCache.set(tenantConfig.tenantId, runtime);
    return runtime;
}
export function listBootstrappedTelegramTenants() {
    return [...telegramRuntimeCache.keys()].sort();
}
export function clearTelegramRuntimeCache() {
    telegramRuntimeCache.clear();
}
