/**
 * Fluxo inicial de resposta do bot Telegram.
 *
 * O objetivo desta fase e provar um caminho completo e confiavel:
 * - update real entra pelo webhook
 * - o runtime seleciona um handler deterministico
 * - o bot produz uma resposta outbound real quando houver canal de resposta
 * - logs suficientes permitem rastrear o caminho inteiro
 */
import { log } from "../lib/logger.js";
import { ORDER_PROGRESS_STATES } from "../order-flow/order-progress-machine.js";
import {
  cancelTelegramOpenOrder,
  receiveTelegramOrderAmount,
  receiveTelegramOrderWallet,
  startTelegramOrderConversation,
} from "../services/order-registration.js";
import {
  confirmTelegramOrder,
  TelegramOrderConfirmationError,
} from "../services/telegram-order-confirmation.js";
import { formatBrlAmountInCents } from "./brl-amount.js";
import { TelegramWebhookError, normalizeTelegramBotError } from "./errors.js";
import { summarizeTelegramApiPayload, summarizeTelegramUpdate } from "./diagnostics.js";

/**
 * Instala middlewares, handlers e observabilidade do fluxo minimo do bot.
 *
 * O fluxo cobre os caminhos explicitamente suportados (`/start` e texto livre)
 * e tambem garante tratamento deterministico para updates fora desse escopo
 * inicial. Isso evita que callback queries, edicoes de mensagem e outros tipos
 * de update fiquem "soltos" no runtime sem rastreabilidade.
 *
 * @param {import("grammy").Bot} bot Instancia do bot atual.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   env?: Record<string, unknown>,
 *   runtimeConfig?: Record<string, unknown>,
 *   db?: import("@cloudflare/workers-types").D1Database,
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
      const orderSession = await startTelegramConversationOrder(ctx, input);
      await ctx.reply(buildTelegramOrderStepReply(input.tenant, orderSession.order));
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
        const orderSession = await startTelegramConversationOrder(ctx, input);
        const normalizedText = normalizeTelegramDecisionText(ctx.msg.text);

        if (orderSession.order.currentStep === ORDER_PROGRESS_STATES.AMOUNT) {
          const amountSession = await receiveTelegramOrderAmount({
            db: input.db,
            tenant: input.tenant,
            order: orderSession.order,
            rawText: ctx.msg.text,
          });

          logTelegramAmountResult(ctx, input, amountSession);

          if (amountSession.parseResult && !amountSession.parseResult.ok) {
            await ctx.reply(buildTelegramInvalidAmountReply(amountSession.parseResult));
            return;
          }

          await ctx.reply(buildTelegramOrderStepReply(input.tenant, amountSession.order));
          return;
        }

        if (orderSession.order.currentStep === ORDER_PROGRESS_STATES.WALLET) {
          const walletSession = await receiveTelegramOrderWallet({
            db: input.db,
            tenant: input.tenant,
            order: orderSession.order,
            rawText: ctx.msg.text,
          });

          logTelegramWalletResult(ctx, input, walletSession);

          if (walletSession.parseResult && !walletSession.parseResult.ok) {
            await ctx.reply(buildTelegramInvalidWalletReply(walletSession.parseResult));
            return;
          }

          await ctx.reply(buildTelegramOrderStepReply(input.tenant, walletSession.order));
          return;
        }

        if (orderSession.order.currentStep === ORDER_PROGRESS_STATES.CONFIRMATION) {
          if (isTelegramCancellationDecision(normalizedText)) {
            const canceledSession = await cancelTelegramOpenOrder({
              db: input.db,
              tenant: input.tenant,
              order: orderSession.order,
            });

            logTelegramConfirmationDecision(ctx, input, "cancel", canceledSession.order, {
              accepted: canceledSession.accepted,
              conflict: canceledSession.conflict,
            });

            await ctx.reply(buildTelegramCanceledReply());
            return;
          }

          if (isTelegramConfirmationDecision(normalizedText)) {
            try {
              const confirmationSession = await confirmTelegramOrder({
                env: input.env,
                db: input.db,
                tenant: input.tenant,
                runtimeConfig: input.runtimeConfig,
                order: orderSession.order,
              });

              logTelegramConfirmationDecision(ctx, input, "confirm", confirmationSession.order, {
                accepted: confirmationSession.accepted,
                conflict: confirmationSession.conflict,
                depositEntryId: confirmationSession.deposit?.depositEntryId,
              });

              if (confirmationSession.deposit) {
                await sendTelegramDepositReadyReply(ctx, input.tenant, confirmationSession.order, confirmationSession.deposit);
                return;
              }

              await ctx.reply(buildTelegramOrderStepReply(input.tenant, confirmationSession.order));
              return;
            } catch (error) {
              if (error instanceof TelegramOrderConfirmationError) {
                logTelegramConfirmationFailure(ctx, input, orderSession.order, error);
                await ctx.reply(error.userMessage);
                return;
              }

              throw error;
            }
          }

          await ctx.reply(buildTelegramConfirmationPrompt(orderSession.order));
          return;
        }

        await ctx.reply(buildTelegramOrderStepReply(input.tenant, orderSession.order));
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

  const handleUnsupportedTelegramUpdate = createLoggedTelegramHandler(
    input,
    "unsupported_update_reply",
    async function replyToUnsupportedUpdate(ctx) {
      await respondToUnsupportedTelegramUpdate(ctx, input);
    },
  );

  bot.use(async function routeUnsupportedTelegramUpdates(ctx, next) {
    if (ctx.state?.telegramHandler) {
      await next();
      return;
    }

    await handleUnsupportedTelegramUpdate(ctx);
    await next();
  });

  bot.use(async function logUnhandledTelegramUpdate(ctx) {
    if (!ctx.state?.telegramHandler) {
      logTelegramEvent(input, "warn", "telegram.handler.not_selected", {
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
  return buildTelegramAmountPrompt(tenant);
}

/**
 * Mensagem para texto comum durante a etapa inicial.
 *
 * Enquanto o parser de valor ainda nao faz parte do recorte, texto livre deve
 * manter o usuario no mesmo contrato conversacional: pedir um valor em BRL.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramTextReply(tenant) {
  return buildTelegramAmountPrompt(tenant);
}

/**
 * Seleciona a resposta conversacional a partir do passo persistido.
 *
 * O bot nunca deve criar um novo pedido so para explicar o proximo passo. Se
 * ja existe um pedido aberto, a resposta reflete o estado atual do agregado e
 * evita regredir ou duplicar a conversa.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @param {{ currentStep?: unknown }} order Pedido aberto da conversa.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramOrderStepReply(tenant, order) {
  switch (order?.currentStep) {
    case ORDER_PROGRESS_STATES.AMOUNT:
      return buildTelegramAmountPrompt(tenant);
    case ORDER_PROGRESS_STATES.WALLET:
      return buildTelegramWalletPrompt(tenant, order);
    case ORDER_PROGRESS_STATES.CONFIRMATION:
      return buildTelegramConfirmationPrompt(order);
    case ORDER_PROGRESS_STATES.CREATING_DEPOSIT:
      return [
        `Seu pedido ${tenant.displayName} já está criando o depósito Pix.`,
        "Aguarde um instante enquanto finalizo essa etapa.",
      ].join("\n\n");
    case ORDER_PROGRESS_STATES.AWAITING_PAYMENT:
      return [
        `Seu pedido ${tenant.displayName} já está aguardando pagamento.`,
        "Use o QR code Pix mais recente enviado nesta conversa.",
      ].join("\n\n");
    default:
      return buildTelegramAmountPrompt(tenant);
  }
}

/**
 * Mensagem de rejeicao para valor BRL invalido.
 *
 * @param {{
 *   reason: string,
 *   maxAmountInCents: number
 * }} parseResult Resultado invalido do parser BRL.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramInvalidAmountReply(parseResult) {
  const maxAmount = formatBrlAmountInCents(parseResult.maxAmountInCents);
  const reasonByCode = {
    empty: "Você enviou uma mensagem vazia.",
    invalid_format: "Não consegui entender esse valor.",
    non_positive: "O valor precisa ser maior que zero.",
    above_limit: `O limite inicial por pedido é ${maxAmount}.`,
  };

  return [
    reasonByCode[parseResult.reason] ?? "Não consegui entender esse valor.",
    "Envie apenas o valor em BRL, por exemplo: 10,50 ou R$ 10,50.",
    `Limite inicial: ${maxAmount}.`,
  ].join("\n\n");
}

/**
 * Mensagem de rejeicao para endereco DePix/Liquid invalido.
 *
 * @param {{ reason: string }} parseResult Resultado invalido do parser.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramInvalidWalletReply(parseResult) {
  const reasonByCode = {
    empty: "Você enviou uma mensagem vazia.",
    uri_not_supported: "Envie apenas o endereço, sem URI ou prefixo de aplicativo.",
    invalid_format: "Não reconheci esse endereço.",
  };

  return [
    reasonByCode[parseResult.reason] ?? "Não reconheci esse endereço.",
    "Cole um endereço DePix/Liquid começando com lq1 ou ex1.",
    "Se a SideSwap mostrar o endereço quebrado em grupos, pode colar tudo como aparece.",
  ].join("\n\n");
}

/**
 * Mensagem para a etapa de coleta do endereco DePix/Liquid.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @param {{ amountInCents?: unknown }} order Pedido aberto.
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramWalletPrompt(tenant, order) {
  const amountLine = Number.isSafeInteger(order?.amountInCents)
    ? `Valor recebido: ${formatBrlAmountInCents(order.amountInCents)}.`
    : `Seu pedido ${tenant.displayName} já tem um valor registrado.`;

  return [
    amountLine,
    "Agora envie seu endereço DePix/Liquid para continuarmos.",
  ].join("\n\n");
}

/**
 * Mensagem de resumo para confirmacao antes de criar deposito.
 *
 * @param {{ amountInCents?: unknown, walletAddress?: unknown }} order Pedido aberto.
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramConfirmationPrompt(order) {
  const amountLine = Number.isSafeInteger(order?.amountInCents)
    ? `Valor: ${formatBrlAmountInCents(order.amountInCents)}`
    : "Valor: pendente";
  const walletLine = typeof order?.walletAddress === "string" && order.walletAddress.length > 0
    ? `Endereço: ${order.walletAddress}`
    : "Endereço: pendente";

  return [
    "Confira seu pedido:",
    amountLine,
    walletLine,
    "Se estiver tudo certo, envie: sim, confirmar ou ok.",
    "Se quiser encerrar este pedido, envie: cancelar.",
  ].join("\n");
}

/**
 * Mensagem curta para pedido cancelado pelo usuario.
 *
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramCanceledReply() {
  return [
    "Pedido cancelado com sucesso.",
    "Quando quiser tentar de novo, envie /start.",
  ].join("\n\n");
}

/**
 * Mensagem principal enviada quando o Pix foi criado com sucesso.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @param {{ amountInCents?: unknown }} order Pedido confirmado.
 * @returns {string} Texto curto de orientacao.
 */
function buildTelegramDepositReadyCaption(tenant, order) {
  const amountLine = Number.isSafeInteger(order?.amountInCents)
    ? `Valor: ${formatBrlAmountInCents(order.amountInCents)}`
    : "Valor: conforme pedido";

  return [
    `Pedido confirmado em ${tenant.displayName}.`,
    amountLine,
    "Seu Pix ja foi gerado.",
  ].join("\n");
}

/**
 * Mensagem de copia-e-cola do Pix.
 *
 * @param {{ qrCopyPaste?: unknown }} deposit Deposito criado na Eulen.
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramPixCopyPasteReply(deposit) {
  return [
    "Pix copia e cola:",
    String(deposit?.qrCopyPaste ?? ""),
  ].join("\n");
}

/**
 * Envia a resposta final do Pix ao usuario com fallback para texto puro.
 *
 * O envio da imagem do QR e desejavel, mas nao pode impedir a entrega do
 * copia-e-cola. Se o `sendPhoto` falhar por qualquer motivo do Telegram, o
 * bot ainda devolve o texto util na mesma conversa.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{ displayName: string }} tenant Tenant atual.
 * @param {{ amountInCents?: unknown }} order Pedido confirmado.
 * @param {{ qrImageUrl?: unknown, qrCopyPaste?: unknown }} deposit Deposito criado.
 * @returns {Promise<void>} Promessa resolvida apos os envios.
 */
async function sendTelegramDepositReadyReply(ctx, tenant, order, deposit) {
  const caption = buildTelegramDepositReadyCaption(tenant, order);
  const copyPasteReply = buildTelegramPixCopyPasteReply(deposit);

  if (typeof deposit?.qrImageUrl === "string" && deposit.qrImageUrl.length > 0) {
    try {
      await ctx.replyWithPhoto(deposit.qrImageUrl, {
        caption,
      });
      await ctx.reply(copyPasteReply);
      return;
    } catch {
      await ctx.reply(caption);
      await ctx.reply(copyPasteReply);
      return;
    }
  }

  await ctx.reply(caption);
  await ctx.reply(copyPasteReply);
}

/**
 * Normaliza o texto livre usado como decisao na etapa de confirmacao.
 *
 * @param {string} text Texto bruto recebido.
 * @returns {string} Texto reduzido para comparacao.
 */
function normalizeTelegramDecisionText(text) {
  return typeof text === "string"
    ? text.trim().toLowerCase()
    : "";
}

/**
 * Detecta comandos curtos de confirmacao.
 *
 * @param {string} normalizedText Texto ja normalizado.
 * @returns {boolean} Verdadeiro quando a mensagem confirma o pedido.
 */
function isTelegramConfirmationDecision(normalizedText) {
  return normalizedText === "sim"
    || normalizedText === "confirmar"
    || normalizedText === "ok";
}

/**
 * Detecta o cancelamento simples do pedido na etapa de confirmacao.
 *
 * @param {string} normalizedText Texto ja normalizado.
 * @returns {boolean} Verdadeiro quando a mensagem pede cancelamento.
 */
function isTelegramCancellationDecision(normalizedText) {
  return normalizedText === "cancelar";
}

/**
 * Mensagem que inicia a coleta de valor em BRL.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramAmountPrompt(tenant) {
  return [
    `Olá! Este é o bot ${tenant.displayName} da DePix.`,
    "Para começar, envie o valor em BRL que você quer comprar.",
    "Exemplo: 100,00",
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
 * Mensagem curta para callback queries sem fluxo de negocio implementado.
 *
 * `answerCallbackQuery` aceita textos breves. Por isso mantemos esta variacao
 * curta e objetiva, enquanto updates com um chat enderecavel recebem uma
 * mensagem mais explicativa.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @returns {string} Texto curto para a callback query.
 */
export function buildTelegramUnsupportedCallbackReply(tenant) {
  return `Recebi sua interação em ${tenant.displayName}. O próximo passo do fluxo ainda será habilitado.`;
}

/**
 * Garante que o update conversacional atual tenha um pedido ativo carregado.
 *
 * A regra do issue #19 e simples: assim que houver contexto suficiente do
 * usuario no Telegram, o sistema precisa materializar ou retomar o pedido no
 * D1. O handler continua responsavel apenas pela resposta ao usuario; esta
 * funcao deixa o pedido pronto para a proxima fatia funcional do fluxo.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   db?: import("@cloudflare/workers-types").D1Database,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   created: boolean,
 *   started: boolean,
 *   conflict: boolean
 * }>} Pedido ativo da conversa.
 */
async function startTelegramConversationOrder(ctx, input) {
  ctx.state ??= {};

  if (ctx.state.telegramOrderSession) {
    return ctx.state.telegramOrderSession;
  }

  if (!input.db) {
    throw new TelegramWebhookError(
      500,
      "telegram_order_registration_failed",
      "Telegram order registration requires a configured database.",
      {
        handlerName: ctx.state.telegramHandler,
        reason: "missing_database_context",
      },
    );
  }

  const telegramUserId = resolveTelegramActorId(ctx);

  if (telegramUserId === undefined) {
    throw new TelegramWebhookError(
      400,
      "telegram_order_registration_failed",
      "Telegram update does not expose a user identifier for order registration.",
      {
        handlerName: ctx.state.telegramHandler,
        reason: "missing_telegram_user_id",
      },
    );
  }

  const orderSession = await startTelegramOrderConversation({
    db: input.db,
    tenant: input.tenant,
    telegramUserId,
  });

  ctx.state.telegramOrderSession = orderSession;

  logTelegramEvent(input, "info", orderSession.created ? "telegram.order.created" : "telegram.order.resumed", {
    handlerName: ctx.state.telegramHandler,
    orderId: orderSession.order.orderId,
    userId: orderSession.order.userId,
    currentStep: orderSession.order.currentStep,
    status: orderSession.order.status,
  });

  if (orderSession.started) {
    logTelegramEvent(input, "info", "telegram.order.started", {
      handlerName: ctx.state.telegramHandler,
      orderId: orderSession.order.orderId,
      userId: orderSession.order.userId,
      currentStep: orderSession.order.currentStep,
      status: orderSession.order.status,
    });
  }

  if (orderSession.conflict) {
    logTelegramEvent(input, "warn", "telegram.order.start_conflict", {
      handlerName: ctx.state.telegramHandler,
      orderId: orderSession.order.orderId,
      userId: orderSession.order.userId,
      currentStep: orderSession.order.currentStep,
      status: orderSession.order.status,
    });
  }

  return orderSession;
}

/**
 * Registra o resultado da tentativa de interpretar valor em BRL.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {{
 *   order: Record<string, unknown>,
 *   accepted: boolean,
 *   conflict: boolean,
 *   parseResult: { ok: boolean, reason?: string, amountInCents?: number } | null
 * }} amountSession Resultado do service de valor.
 */
function logTelegramAmountResult(ctx, input, amountSession) {
  if (!amountSession.parseResult) {
    return;
  }

  if (!amountSession.parseResult.ok) {
    logTelegramEvent(input, "info", "telegram.order.amount_rejected", {
      handlerName: ctx.state.telegramHandler,
      orderId: amountSession.order.orderId,
      userId: amountSession.order.userId,
      reason: amountSession.parseResult.reason,
      currentStep: amountSession.order.currentStep,
    });
    return;
  }

  logTelegramEvent(input, amountSession.conflict ? "warn" : "info", amountSession.accepted
    ? "telegram.order.amount_received"
    : "telegram.order.amount_conflict", {
    handlerName: ctx.state.telegramHandler,
    orderId: amountSession.order.orderId,
    userId: amountSession.order.userId,
    amountInCents: amountSession.parseResult.amountInCents,
    currentStep: amountSession.order.currentStep,
    status: amountSession.order.status,
  });
}

/**
 * Registra o resultado da tentativa de interpretar endereco DePix/Liquid.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {{
 *   order: Record<string, unknown>,
 *   accepted: boolean,
 *   conflict: boolean,
 *   parseResult: { ok: boolean, reason?: string, walletAddress?: string } | null
 * }} walletSession Resultado do service de endereco.
 */
function logTelegramWalletResult(ctx, input, walletSession) {
  if (!walletSession.parseResult) {
    return;
  }

  if (!walletSession.parseResult.ok) {
    logTelegramEvent(input, "info", "telegram.order.wallet_rejected", {
      handlerName: ctx.state.telegramHandler,
      orderId: walletSession.order.orderId,
      userId: walletSession.order.userId,
      reason: walletSession.parseResult.reason,
      currentStep: walletSession.order.currentStep,
    });
    return;
  }

  logTelegramEvent(input, walletSession.conflict ? "warn" : "info", walletSession.accepted
    ? "telegram.order.wallet_received"
    : "telegram.order.wallet_conflict", {
    handlerName: ctx.state.telegramHandler,
    orderId: walletSession.order.orderId,
    userId: walletSession.order.userId,
    walletAddressPrefix: walletSession.parseResult.walletAddress?.slice(0, 3),
    currentStep: walletSession.order.currentStep,
    status: walletSession.order.status,
  });
}

/**
 * Registra o resultado de uma decisao de confirmacao ou cancelamento.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {"confirm" | "cancel"} decision Tipo da decisao do usuario.
 * @param {Record<string, unknown>} order Pedido apos a tentativa.
 * @param {Record<string, unknown>} details Metadados adicionais.
 */
function logTelegramConfirmationDecision(ctx, input, decision, order, details) {
  logTelegramEvent(input, "info", `telegram.order.${decision}_handled`, {
    handlerName: ctx.state.telegramHandler,
    orderId: order.orderId,
    userId: order.userId,
    currentStep: order.currentStep,
    status: order.status,
    ...details,
  });
}

/**
 * Registra falhas controladas da confirmacao antes da resposta ao usuario.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {Record<string, unknown>} order Pedido que tentou confirmar.
 * @param {{ code: string, details?: Record<string, unknown> }} error Erro controlado do service.
 */
function logTelegramConfirmationFailure(ctx, input, order, error) {
  logTelegramEvent(input, "warn", "telegram.order.confirmation_failed", {
    handlerName: ctx.state.telegramHandler,
    orderId: order.orderId,
    userId: order.userId,
    currentStep: order.currentStep,
    errorCode: error.code,
    ...error.details,
  });
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
 * Garante um tratamento deterministico para updates que nao pertencem aos
 * fluxos explicitamente suportados nesta fase do bot.
 *
 * A intencao aqui nao e "inventar" um fluxo de negocio. Em vez disso:
 * - callback queries recebem `answerCallbackQuery`, que e o ack correto
 * - updates com chat enderecavel recebem uma mensagem explicativa
 * - updates sem superficie de resposta sao marcados como tratados e logados
 *
 * Assim, o runtime cobre explicitamente o comportamento para updates fora do
 * escopo inicial do MVP, sem deixar lacunas silenciosas.
 *
 * @param {any} ctx Contexto do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional atual.
 */
async function respondToUnsupportedTelegramUpdate(ctx, input) {
  if (ctx.callbackQuery?.id) {
    await ctx.answerCallbackQuery({
      text: buildTelegramUnsupportedCallbackReply(input.tenant),
    });
    return;
  }

  const replyChatId = resolveTelegramReplyChatId(ctx.update);

  if (replyChatId !== undefined) {
    await ctx.api.sendMessage(replyChatId, buildTelegramUnsupportedMessageReply(input.tenant));
    return;
  }

  logTelegramEvent(input, "info", "telegram.outbound.skipped", {
    reason: "unsupported_update_has_no_reply_channel",
    update: ctx.state?.telegramUpdateSummary ?? summarizeTelegramUpdate(ctx.update),
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
 * Descobre se o update atual tem algum chat que permita uma resposta via
 * `sendMessage`.
 *
 * Nem todo update do Telegram traz uma superficie de resposta. Callback query,
 * por exemplo, deve ser respondida preferencialmente com
 * `answerCallbackQuery`; ja updates como `inline_query` nao oferecem um chat
 * enderecavel.
 *
 * @param {Record<string, any>} update Update bruto recebido.
 * @returns {number | string | undefined} Chat id quando houver destino valido.
 */
function resolveTelegramReplyChatId(update) {
  return update?.message?.chat?.id
    ?? update?.edited_message?.chat?.id
    ?? update?.channel_post?.chat?.id
    ?? update?.edited_channel_post?.chat?.id
    ?? update?.business_message?.chat?.id
    ?? update?.edited_business_message?.chat?.id
    ?? undefined;
}

/**
 * Resolve o identificador do ator primario do update atual.
 *
 * Para o recorte atual do bot, `from.id` e o identificador canonico usado para
 * vincular o pedido ao usuario do Telegram. A funcao cobre as superficies que
 * podem chegar aos handlers conversacionais presentes nesta fase.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @returns {string | number | undefined} Identificador do usuario, quando existir.
 */
function resolveTelegramActorId(ctx) {
  return ctx.from?.id
    ?? ctx.message?.from?.id
    ?? ctx.update?.message?.from?.id
    ?? undefined;
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
