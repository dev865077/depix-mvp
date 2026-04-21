import type { D1Database } from "@cloudflare/workers-types";
import type { Bot } from "grammy";

import type { DepositRecord, OrderRecord } from "../types/persistence.js";

export type TelegramSupportedCommand = "/start" | "/help" | "/status" | "/cancel";

export type TelegramRawUpdateType =
  | "message"
  | "edited_message"
  | "channel_post"
  | "edited_channel_post"
  | "business_message"
  | "edited_business_message"
  | "callback_query"
  | "inline_query"
  | "unknown";

export type TelegramNormalizedUpdateKind = "message" | "callback_query" | "unsupported";

export interface TelegramRequestContext {
  requestId?: string;
  method?: string;
  path?: string;
}

export interface TelegramTenant {
  tenantId: string;
  displayName: string;
}

export interface TelegramTenantConfig extends TelegramTenant {
  secretBindings: Record<string, string>;
  splitConfigBindings?: Record<string, string>;
}

export interface TelegramNormalizedUpdate {
  updateKind: TelegramNormalizedUpdateKind;
  rawUpdateType: TelegramRawUpdateType;
  chatId?: string;
  fromId?: string;
  text?: string;
  command?: TelegramSupportedCommand | string;
  callbackData?: string;
  hasReplyChannel: boolean;
}

export interface TelegramRawUpdateMetadata {
  chatId?: string;
  parseFailed: boolean;
  normalizedUpdate?: TelegramNormalizedUpdate | null;
}

export interface TelegramRawUpdateEnvelope {
  metadata: TelegramRawUpdateMetadata;
  normalizedUpdate: TelegramNormalizedUpdate | null;
}

export interface TelegramInvalidPayloadDetails {
  code: "telegram_invalid_payload";
  source: "telegram";
  reason: string;
  field?: string;
  updateType?: TelegramRawUpdateType | "unknown";
  requestId?: string;
  method?: string;
  path?: string;
}

export interface TelegramRuntimeInput {
  tenant: TelegramTenant;
  env?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  db?: D1Database;
  rawTelegramUpdate?: TelegramRawUpdateMetadata;
  requestContext?: TelegramRequestContext;
}

export interface TelegramWebhookCallbackOptions {
  telegramBotToken: string;
  telegramWebhookSecret?: string;
  env?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  db?: D1Database;
  rawTelegramUpdate?: TelegramRawUpdateMetadata;
  requestContext?: TelegramRequestContext;
}

export type TelegramWebhookCallbackInput = string | TelegramWebhookCallbackOptions;

export interface TelegramBootstrapBotInfo {
  id: number;
  is_bot: true;
  first_name: string;
  username: string;
  can_join_groups: boolean;
  can_manage_bots: false;
  can_connect_to_business: false;
  can_read_all_group_messages: false;
  supports_inline_queries: false;
  has_main_web_app: false;
  has_topics_enabled: false;
  allows_users_to_create_topics: false;
}

export interface TelegramRuntime {
  engine: "grammy";
  tenantId: string;
  botInfo: TelegramBootstrapBotInfo;
  createBot: (telegramBotToken: string, options?: Omit<TelegramWebhookCallbackOptions, "telegramBotToken" | "telegramWebhookSecret">) => Bot;
  createWebhookCallback: (input: TelegramWebhookCallbackInput) => (request: Request) => Promise<Response>;
}

export interface TelegramOrderLike
  extends Pick<Partial<OrderRecord>, "currentStep" | "amountInCents" | "walletAddress" | "status" | "orderId"> {}

export interface TelegramDepositLike
  extends Pick<Partial<DepositRecord>, "qrCopyPaste" | "expiration"> {}

export interface TelegramInvalidAmountParseResult {
  reason: string;
  maxAmountInCents: number;
}

export interface TelegramInvalidWalletParseResult {
  reason: string;
}
