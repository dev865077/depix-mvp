import { BotError, GrammyError, HttpError } from "grammy";
import { summarizeTelegramUpdate } from "./diagnostics.js";
/**
 * Erro HTTP controlado para o webhook do Telegram.
 */
export class TelegramWebhookError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details, cause) {
        super(message, {
            cause,
        });
        this.name = "TelegramWebhookError";
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export class TelegramPayloadValidationError extends TelegramWebhookError {
    constructor(details, cause) {
        super(400, "invalid_webhook_payload", "Telegram webhook payload is invalid.", details, cause);
        this.name = "TelegramPayloadValidationError";
    }
}
export function buildInvalidTelegramPayloadDetails(reason, input = {}) {
    return {
        code: "telegram_invalid_payload",
        source: "telegram",
        reason,
        ...input,
    };
}
/**
 * Normaliza um erro do grammY para o contrato local do webhook.
 */
export function normalizeTelegramWebhookError(error) {
    if (error instanceof TelegramWebhookError) {
        return error;
    }
    if (error instanceof BotError) {
        return normalizeTelegramBotError(error);
    }
    return new TelegramWebhookError(500, "telegram_update_processing_failed", "Telegram update processing failed.", undefined, error);
}
/**
 * Traduz falhas de middleware do grammY para um erro HTTP controlado.
 */
export function normalizeTelegramBotError(error) {
    const cause = error.error;
    const updateSummary = summarizeTelegramUpdate(error.ctx.update);
    const contextState = error.ctx.state;
    const handlerName = typeof contextState?.telegramHandler === "string"
        ? contextState.telegramHandler
        : undefined;
    if (cause instanceof TelegramWebhookError) {
        return cause;
    }
    if (cause instanceof GrammyError) {
        return new TelegramWebhookError(502, "telegram_outbound_request_failed", "Telegram outbound API call failed.", {
            ...updateSummary,
            handlerName,
            method: cause.method,
            errorCode: cause.error_code,
            description: cause.description,
        }, cause);
    }
    if (cause instanceof HttpError) {
        return new TelegramWebhookError(502, "telegram_outbound_transport_failed", "Telegram outbound transport failed.", {
            ...updateSummary,
            handlerName,
            cause: cause.error instanceof Error ? cause.error.message : String(cause.error),
        }, cause);
    }
    return new TelegramWebhookError(500, "telegram_update_processing_failed", "Telegram update processing failed.", {
        ...updateSummary,
        handlerName,
        cause: cause instanceof Error ? cause.message : String(cause),
    }, cause);
}
