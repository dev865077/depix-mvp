/**
 * Fluxo inicial de resposta do bot Telegram.
 *
 * O objetivo desta fase e provar um caminho completo e confiavel:
 * - update real entra pelo webhook
 * - o runtime seleciona um handler deterministico
 * - o bot produz uma resposta outbound real
 * - logs suficientes permitem rastrear o caminho inteiro
 */
import { log } from "../lib/logger.js";
import { normalizeTelegramBotError } from "./errors.js";
import { summarizeTelegramApiPayload, summarizeTelegramUpdate } from "./diagnostics.js";

/**
 * Instala middlewares, handlers e observabilidade do fluxo minimo do bot.
 *
 * @param {import("grammy").Bot} bot Instancia do bot atual.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto do runtime atual.
 */
export function installTelegramReplyFlow(bot, input) {
  installTelegramOutboundLogging(bot, input);

  bot.use(async function attachTelegramContext(ctx, next) {
    ctx.state ??= {};
    ctx.state.tenant = {
      tenantId: input.tenant.tenantId,
      displayName: input.tenant.displayName,
    };
    ctx.state.requestContext = input.requestContext ?? {};
    ctx.state.telegramUpdateSummary = summarizeTelegramUpdate(ctx.update);

    logTelegramEvent(input, "info", "telegram.update.received", {
      update: ctx.state.telegramUpdateSummary,
    });

    await next();
  });

  bot.command("start", createLoggedTelegramHandler(
    input,
    "start_command",
    async function replyToStart(ctx) {
      await ctx.reply(buildTelegramStartReply(input.tenant));
    },
  ));

  bot.on("message:text").filter(
    function skipCommandsInGenericTextFlow(ctx) {
      return !ctx.msg?.text?.startsWith("/");
    },
    createLoggedTelegramHandler(
      input,
      "text_message_reply",
      async function replyToTextMessage(ctx) {
        await ctx.reply(buildTelegramTextReply(input.tenant));
      },
    ),
  );

  bot.on("message").filter(
    function selectNonTextMessages(ctx) {
      return typeof ctx.msg?.text !== "string";
    },
    createLoggedTelegramHandler(
      input,
      "unsupported_message_reply",
      async function replyToUnsupportedMessage(ctx) {
        await ctx.reply(buildTelegramUnsupportedMessageReply(input.tenant));
      },
    ),
  );

  bot.use(async function logUnhandledTelegramUpdate(ctx) {
    if (!ctx.state?.telegramHandler) {
      logTelegramEvent(input, "info", "telegram.handler.not_selected", {
        update: ctx.state?.telegramUpdateSummary ?? summarizeTelegramUpdate(ctx.update),
      });
    }
  });

  bot.catch(function rethrowTelegramMiddlewareError(error) {
    throw normalizeTelegramBotError(error);
  });
}

/**
 * Mensagem de entrada para `/start`.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramStartReply(tenant) {
  return [
    `Olá! Este é o bot ${tenant.displayName} da DePix.`,
    "A resposta inicial do bot já está ativa.",
    "Agora podemos evoluir o fluxo conversacional completo com segurança.",
  ].join("\n\n");
}

/**
 * Mensagem de confirmacao para texto comum.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramTextReply(tenant) {
  return [
    `Recebi sua mensagem no canal ${tenant.displayName}.`,
    "O caminho de resposta do bot está ativo e pronto para as próximas etapas do fluxo.",
  ].join("\n\n");
}

/**
 * Mensagem para updates de mensagem nao textual.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramUnsupportedMessageReply(tenant) {
  return [
    `Recebi sua interação em ${tenant.displayName}.`,
    "Nesta fase eu respondo a mensagens de texto e ao comando /start.",
  ].join("\n\n");
}

/**
 * Instala telemetria para chamadas outbound da Bot API.
 *
 * @param {import("grammy").Bot} bot Bot atual.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 */
function installTelegramOutboundLogging(bot, input) {
  bot.api.config.use(async function logTelegramApiCall(prev, method, payload, signal) {
    const payloadSummary = summarizeTelegramApiPayload(method, payload);

    logTelegramEvent(input, "info", "telegram.outbound.attempt", {
      outbound: payloadSummary,
    });

    try {
      const result = await prev(method, payload, signal);

      if (result && typeof result === "object" && result.ok === false) {
        logTelegramEvent(input, "error", "telegram.outbound.failed", {
          outbound: payloadSummary,
          errorCode: result.error_code,
          description: result.description,
        });

        return result;
      }

      logTelegramEvent(input, "info", "telegram.outbound.succeeded", {
        outbound: payloadSummary,
      });

      return result;
    } catch (error) {
      logTelegramEvent(input, "error", "telegram.outbound.failed", {
        outbound: payloadSummary,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  });
}

/**
 * Cria um handler com logging consistente de selecao e fim.
 *
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {string} handlerName Nome estavel do handler.
 * @param {(ctx: any) => Promise<void>} handler Implementacao do handler.
 * @returns {(ctx: any) => Promise<void>} Middleware com observabilidade.
 */
function createLoggedTelegramHandler(input, handlerName, handler) {
  return async function loggedTelegramHandler(ctx) {
    ctx.state ??= {};
    ctx.state.telegramHandler = handlerName;

    const updateSummary = ctx.state.telegramUpdateSummary ?? summarizeTelegramUpdate(ctx.update);

    logTelegramEvent(input, "info", "telegram.handler.selected", {
      handlerName,
      update: updateSummary,
    });

    try {
      await handler(ctx);

      logTelegramEvent(input, "info", "telegram.handler.completed", {
        handlerName,
        update: updateSummary,
      });
    } catch (error) {
      logTelegramEvent(input, "error", "telegram.handler.failed", {
        handlerName,
        update: updateSummary,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  };
}

/**
 * Escreve um evento de log do fluxo Telegram com correlacao de request.
 *
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional atual.
 * @param {"debug" | "info" | "warn" | "error"} level Nivel do evento.
 * @param {string} message Codigo textual do evento.
 * @param {Record<string, unknown> | undefined} details Detalhes estruturados.
 */
function logTelegramEvent(input, level, message, details) {
  log(input.runtimeConfig, {
    level,
    message,
    tenantId: input.tenant.tenantId,
    requestId: input.requestContext?.requestId,
    method: input.requestContext?.method,
    path: input.requestContext?.path,
    details,
  });
}
