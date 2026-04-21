import { isInteger, isLosslessNumber, parse } from "lossless-json";
import { TelegramPayloadValidationError, buildInvalidTelegramPayloadDetails, } from "./errors.js";
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeRawTelegramIdentifier(value) {
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
        return String(value);
    }
    if (isLosslessNumber(value)) {
        const normalizedValue = value.toString();
        if (isInteger(normalizedValue)) {
            return normalizedValue;
        }
    }
    return undefined;
}
function detectRawUpdateType(update) {
    const supportedTypes = [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "business_message",
        "edited_business_message",
        "callback_query",
        "inline_query",
    ];
    return supportedTypes.find((key) => key in update) ?? "unknown";
}
function normalizeTelegramCommand(text) {
    if (!text.startsWith("/")) {
        return undefined;
    }
    const command = text.trim().split(/\s+/u)[0];
    return command.length > 0 ? command : undefined;
}
function assertRecord(value, reason, requestContext, updateType, field) {
    if (isRecord(value)) {
        return value;
    }
    throw new TelegramPayloadValidationError(buildInvalidTelegramPayloadDetails(reason, {
        field,
        updateType,
        ...requestContext,
    }));
}
function buildMessageLikeUpdate(rawUpdateType, messageValue, requestContext) {
    const message = assertRecord(messageValue, "telegram_message_missing", requestContext, rawUpdateType, rawUpdateType);
    const chat = assertRecord(message.chat, "telegram_chat_missing", requestContext, rawUpdateType, `${rawUpdateType}.chat`);
    const chatId = normalizeRawTelegramIdentifier(chat.id);
    if (!chatId) {
        throw new TelegramPayloadValidationError(buildInvalidTelegramPayloadDetails("telegram_chat_id_missing", {
            field: `${rawUpdateType}.chat.id`,
            updateType: rawUpdateType,
            ...requestContext,
        }));
    }
    const from = isRecord(message.from) ? message.from : undefined;
    const fromId = normalizeRawTelegramIdentifier(from?.id);
    const text = typeof message.text === "string" ? message.text : undefined;
    if ("text" in message && typeof message.text !== "string") {
        throw new TelegramPayloadValidationError(buildInvalidTelegramPayloadDetails("telegram_message_text_invalid", {
            field: `${rawUpdateType}.text`,
            updateType: rawUpdateType,
            ...requestContext,
        }));
    }
    if (rawUpdateType === "message" && text) {
        return {
            updateKind: "message",
            rawUpdateType,
            chatId,
            fromId,
            text,
            command: normalizeTelegramCommand(text),
            hasReplyChannel: true,
        };
    }
    return {
        updateKind: "unsupported",
        rawUpdateType,
        chatId,
        fromId,
        text,
        command: text ? normalizeTelegramCommand(text) : undefined,
        hasReplyChannel: true,
    };
}
function buildCallbackQueryUpdate(callbackQueryValue, requestContext) {
    const callbackQuery = assertRecord(callbackQueryValue, "telegram_callback_query_missing", requestContext, "callback_query", "callback_query");
    if (typeof callbackQuery.id !== "string" || callbackQuery.id.length === 0) {
        throw new TelegramPayloadValidationError(buildInvalidTelegramPayloadDetails("telegram_callback_query_id_missing", {
            field: "callback_query.id",
            updateType: "callback_query",
            ...requestContext,
        }));
    }
    const from = isRecord(callbackQuery.from) ? callbackQuery.from : undefined;
    const fromId = normalizeRawTelegramIdentifier(from?.id);
    const message = isRecord(callbackQuery.message) ? callbackQuery.message : undefined;
    const chat = isRecord(message?.chat) ? message.chat : undefined;
    const chatId = normalizeRawTelegramIdentifier(chat?.id);
    return {
        updateKind: "callback_query",
        rawUpdateType: "callback_query",
        chatId,
        fromId,
        callbackData: typeof callbackQuery.data === "string" ? callbackQuery.data : undefined,
        hasReplyChannel: true,
    };
}
function buildUnsupportedUpdate(rawUpdateType, update) {
    const sourceValue = rawUpdateType === "unknown" ? update : update[rawUpdateType];
    const sourceRecord = isRecord(sourceValue) ? sourceValue : undefined;
    const message = isRecord(sourceRecord?.message) ? sourceRecord.message : sourceRecord;
    const chat = isRecord(message?.chat) ? message.chat : undefined;
    const from = isRecord(sourceRecord?.from)
        ? sourceRecord.from
        : isRecord(message?.from)
            ? message.from
            : undefined;
    const chatId = normalizeRawTelegramIdentifier(chat?.id);
    const fromId = normalizeRawTelegramIdentifier(from?.id);
    const hasReplyChannel = rawUpdateType === "callback_query" || Boolean(chatId);
    return {
        updateKind: "unsupported",
        rawUpdateType,
        chatId,
        fromId,
        hasReplyChannel,
    };
}
function buildNormalizedUpdate(update, requestContext) {
    const rawUpdateType = detectRawUpdateType(update);
    switch (rawUpdateType) {
        case "message":
        case "edited_message":
        case "channel_post":
        case "edited_channel_post":
        case "business_message":
        case "edited_business_message":
            return buildMessageLikeUpdate(rawUpdateType, update[rawUpdateType], requestContext);
        case "callback_query":
            return buildCallbackQueryUpdate(update.callback_query, requestContext);
        case "inline_query":
            return buildUnsupportedUpdate(rawUpdateType, update);
        default:
            return buildUnsupportedUpdate("unknown", update);
    }
}
export function parseTelegramRawUpdateEnvelope(rawBody, requestContext = {}) {
    let parsedUpdate;
    try {
        parsedUpdate = parse(rawBody);
    }
    catch (error) {
        throw new TelegramPayloadValidationError(buildInvalidTelegramPayloadDetails("telegram_payload_invalid_json", requestContext), error);
    }
    if (!isRecord(parsedUpdate)) {
        throw new TelegramPayloadValidationError(buildInvalidTelegramPayloadDetails("telegram_payload_not_object", requestContext));
    }
    const normalizedUpdate = buildNormalizedUpdate(parsedUpdate, requestContext);
    return {
        metadata: {
            chatId: normalizedUpdate.chatId,
            parseFailed: false,
            normalizedUpdate,
        },
        normalizedUpdate,
    };
}
/**
 * Extrai metadados seguros do update mantendo compatibilidade com a borda atual.
 */
export function extractTelegramRawUpdateMetadata(rawBody) {
    try {
        return parseTelegramRawUpdateEnvelope(rawBody).metadata;
    }
    catch (error) {
        if (error instanceof TelegramPayloadValidationError) {
            return {
                chatId: undefined,
                parseFailed: true,
                normalizedUpdate: null,
            };
        }
        throw error;
    }
}
