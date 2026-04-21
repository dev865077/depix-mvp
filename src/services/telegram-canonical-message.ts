import { log } from "../lib/logger.js";
import { updateOrderById } from "../db/repositories/orders-repository.js";

import type { D1Database } from "@cloudflare/workers-types";
import type { InlineKeyboardMarkup, Message } from "@grammyjs/types";
import type { Api, RawApi } from "grammy";
import type { OrderRecord } from "../types/persistence.js";

export type TelegramCanonicalMessageKind = "text" | "photo";

type TelegramCanonicalMessagePayload = {
  kind: TelegramCanonicalMessageKind;
  text: string;
  photoUrl?: string | null;
  replyMarkup?: InlineKeyboardMarkup;
};

type SyncTelegramCanonicalMessageInput = {
  api: Api<RawApi>;
  db?: D1Database;
  runtimeConfig: Record<string, unknown>;
  requestContext?: { requestId?: string };
  tenant: { tenantId: string };
  order: OrderRecord;
  payload: TelegramCanonicalMessagePayload;
  fallbackOnEditFailure?: {
    text: string;
    replyMarkup?: InlineKeyboardMarkup;
  } | null;
};

function isSafeMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function buildReplyOptions(payload: TelegramCanonicalMessagePayload) {
  return payload.replyMarkup
    ? { reply_markup: payload.replyMarkup }
    : undefined;
}

function buildFallbackReplyOptions(input: SyncTelegramCanonicalMessageInput["fallbackOnEditFailure"]) {
  return input?.replyMarkup
    ? { reply_markup: input.replyMarkup }
    : undefined;
}

async function persistCanonicalMessageMetadata(
  db: D1Database | undefined,
  tenantId: string,
  orderId: string,
  message: Message.TextMessage | Message.PhotoMessage,
  kind: TelegramCanonicalMessageKind,
) {
  if (!db) {
    return;
  }

  await updateOrderById(db, tenantId, orderId, {
    telegramCanonicalMessageId: message.message_id,
    telegramCanonicalMessageKind: kind,
  });
}

async function sendCanonicalMessage(input: SyncTelegramCanonicalMessageInput) {
  const chatId = input.order.telegramChatId;

  if (typeof chatId !== "string" || chatId.trim().length === 0) {
    throw new Error("telegram canonical message requires telegramChatId");
  }

  if (input.payload.kind === "photo" && typeof input.payload.photoUrl === "string" && input.payload.photoUrl.length > 0) {
    try {
      const message = await input.api.sendPhoto(chatId, input.payload.photoUrl, {
        caption: input.payload.text,
        ...buildReplyOptions(input.payload),
      });

      await persistCanonicalMessageMetadata(input.db, input.tenant.tenantId, input.order.orderId, message, "photo");
      return {
        action: "sent",
        kind: "photo" as const,
      };
    } catch (error) {
      logCanonicalMessageError(input, "telegram.canonical_message.photo_send_failed", {
        nextKind: input.payload.kind,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const message = await input.api.sendMessage(chatId, input.payload.text, buildReplyOptions(input.payload));
  await persistCanonicalMessageMetadata(input.db, input.tenant.tenantId, input.order.orderId, message, "text");
  return {
    action: "sent",
    kind: "text" as const,
  };
}

async function editCanonicalMessage(input: SyncTelegramCanonicalMessageInput) {
  const chatId = input.order.telegramChatId;
  const messageId = input.order.telegramCanonicalMessageId;
  const storedKind = input.order.telegramCanonicalMessageKind;

  if (typeof chatId !== "string" || chatId.trim().length === 0 || !isSafeMessageId(messageId) || typeof storedKind !== "string") {
    return null;
  }

  if (storedKind === "photo") {
    await input.api.editMessageCaption(chatId, messageId, {
      caption: input.payload.text,
      ...buildReplyOptions(input.payload),
    });
    return {
      action: "edited",
      kind: "photo" as const,
    };
  }

  await input.api.editMessageText(chatId, messageId, input.payload.text, buildReplyOptions(input.payload));
  return {
    action: "edited",
    kind: "text" as const,
  };
}

function logCanonicalMessageEvent(
  input: SyncTelegramCanonicalMessageInput,
  message: string,
  details: Record<string, unknown>,
) {
  log(input.runtimeConfig, {
    level: "info",
    message,
    tenantId: input.tenant.tenantId,
    requestId: input.requestContext?.requestId,
    details: {
      orderId: input.order.orderId,
      telegramChatId: input.order.telegramChatId,
      telegramCanonicalMessageId: input.order.telegramCanonicalMessageId,
      telegramCanonicalMessageKind: input.order.telegramCanonicalMessageKind,
      ...details,
    },
  });
}

function logCanonicalMessageError(
  input: SyncTelegramCanonicalMessageInput,
  message: string,
  details: Record<string, unknown>,
) {
  log(input.runtimeConfig, {
    level: "warn",
    message,
    tenantId: input.tenant.tenantId,
    requestId: input.requestContext?.requestId,
    details: {
      orderId: input.order.orderId,
      telegramChatId: input.order.telegramChatId,
      telegramCanonicalMessageId: input.order.telegramCanonicalMessageId,
      telegramCanonicalMessageKind: input.order.telegramCanonicalMessageKind,
      ...details,
    },
  });
}

export async function syncTelegramCanonicalMessage(input: SyncTelegramCanonicalMessageInput) {
  try {
    const edited = await editCanonicalMessage(input);

    if (edited) {
      logCanonicalMessageEvent(input, "telegram.canonical_message.edited", {
        nextKind: input.payload.kind,
      });
      return {
        delivered: true,
        edited: true,
        fallbackSent: false,
      };
    }
  } catch (error) {
    logCanonicalMessageError(input, "telegram.canonical_message.edit_failed", {
      nextKind: input.payload.kind,
      cause: error instanceof Error ? error.message : String(error),
    });

    if (input.fallbackOnEditFailure && typeof input.order.telegramChatId === "string" && input.order.telegramChatId.length > 0) {
      const fallbackMessage = await input.api.sendMessage(
        input.order.telegramChatId,
        input.fallbackOnEditFailure.text,
        buildFallbackReplyOptions(input.fallbackOnEditFailure),
      );
      await persistCanonicalMessageMetadata(
        input.db,
        input.tenant.tenantId,
        input.order.orderId,
        fallbackMessage,
        "text",
      );
      logCanonicalMessageEvent(input, "telegram.canonical_message.fallback_sent", {
        nextKind: input.payload.kind,
        fallbackMessageId: fallbackMessage.message_id,
      });
      return {
        delivered: true,
        edited: false,
        fallbackSent: true,
      };
    }
  }

  const sent = await sendCanonicalMessage(input);
  logCanonicalMessageEvent(input, "telegram.canonical_message.sent", {
    nextKind: sent.kind,
  });
  return {
    delivered: true,
    edited: false,
    fallbackSent: false,
  };
}
