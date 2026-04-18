/**
 * Erros do fluxo Telegram.
 *
 * Esta camada traduz falhas internas do grammY/Bot API para um contrato local
 * explicito, com status HTTP, codigo estavel e detalhes seguros para suporte.
 */
import { BotError, GrammyError, HttpError } from "grammy";

import { summarizeTelegramUpdate } from "./diagnostics.js";

/**
 * Erro HTTP controlado para o webhook do Telegram.
 */
export class TelegramWebhookError extends Error {
  /**
   * @param {number} status Status HTTP a devolver.
   * @param {string} code Codigo estavel para contrato de erro.
   * @param {string} message Mensagem humana do erro.
   * @param {Record<string, unknown> | undefined} details Detalhes estruturados.
   * @param {unknown} [cause] Erro original.
   */
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

/**
 * Normaliza um erro do grammY para o contrato local do webhook.
 *
 * @param {unknown} error Erro recebido do runtime.
 * @returns {TelegramWebhookError} Erro mapeado para a borda HTTP.
 */
export function normalizeTelegramWebhookError(error) {
  if (error instanceof TelegramWebhookError) {
    return error;
  }

  if (error instanceof BotError) {
    return normalizeTelegramBotError(error);
  }

  return new TelegramWebhookError(
    500,
    "telegram_update_processing_failed",
    "Telegram update processing failed.",
    undefined,
    error,
  );
}

/**
 * Traduz falhas de middleware do grammY para um erro HTTP controlado.
 *
 * @param {BotError} error Erro encapsulado pelo grammY.
 * @returns {TelegramWebhookError} Erro pronto para a borda HTTP.
 */
export function normalizeTelegramBotError(error) {
  const cause = error.error;
  const updateSummary = summarizeTelegramUpdate(error.ctx.update);
  const handlerName = typeof error.ctx.state?.telegramHandler === "string"
    ? error.ctx.state.telegramHandler
    : undefined;

  if (cause instanceof GrammyError) {
    return new TelegramWebhookError(
      502,
      "telegram_outbound_request_failed",
      "Telegram outbound API call failed.",
      {
        ...updateSummary,
        handlerName,
        method: cause.method,
        errorCode: cause.error_code,
        description: cause.description,
      },
      cause,
    );
  }

  if (cause instanceof HttpError) {
    return new TelegramWebhookError(
      502,
      "telegram_outbound_transport_failed",
      "Telegram outbound transport failed.",
      {
        ...updateSummary,
        handlerName,
        cause: cause.error instanceof Error ? cause.error.message : String(cause.error),
      },
      cause,
    );
  }

  return new TelegramWebhookError(
    500,
    "telegram_update_processing_failed",
    "Telegram update processing failed.",
    {
      ...updateSummary,
      handlerName,
      cause: cause instanceof Error ? cause.message : String(cause),
    },
    cause,
  );
}
