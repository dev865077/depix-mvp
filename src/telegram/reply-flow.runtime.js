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
import { readTenantSecret } from "../config/tenants.js";
import { getLatestDepositByOrderId } from "../db/repositories/deposits-repository.js";
import { getOrderById } from "../db/repositories/orders-repository.js";
import { ORDER_PROGRESS_STATES } from "../order-flow/order-progress-machine.js";
import {
  cancelTelegramOpenOrder,
  getTelegramOpenOrderForUser,
  getTelegramRelevantOrderForUser,
  receiveTelegramOrderAmount,
  receiveTelegramOrderWallet,
  restartTelegramOpenOrderConversation,
  startTelegramOrderConversation,
} from "../services/order-registration.js";
import {
  confirmTelegramOrder,
  TelegramOrderConfirmationError,
} from "../services/telegram-order-confirmation.js";
import { processDepositRecheck } from "../services/eulen-deposit-recheck.js";
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
 * Importante para o contrato de `telegram_chat_id`: nesta fase, apenas
 * `message`/`message:text` e order-bearing. Callback query, edited message,
 * channel post e outras superficies sao explicitamente unsupported e nao
 * criam nem retomam pedido.
 *
 * @param {import("grammy").Bot} bot Instancia do bot atual.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   env?: Record<string, unknown>,
 *   runtimeConfig?: Record<string, unknown>,
 *   db?: import("@cloudflare/workers-types").D1Database,
 *   rawTelegramUpdate?: { chatId?: string, parseFailed: boolean },
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
      if (orderSession.chatBinding?.blocked) {
        await ctx.reply(buildTelegramChatBindingBlockedReply());
        return;
      }

      const deposit = await readLatestDepositForTelegramOrder(input, orderSession.order);
      const reconciled = await reconcileTelegramAwaitingPaymentOrder(ctx, input, orderSession.order, deposit, "start");

      if (reconciled.order.currentStep !== orderSession.order.currentStep || reconciled.order.status !== orderSession.order.status) {
        await replyTelegramStatus(ctx, input.tenant, reconciled.order, reconciled.deposit);
        return;
      }

      await replyTelegramOrderStep(ctx, input.tenant, reconciled.order);
    },
  ));

  bot.command("help", createLoggedTelegramHandler(
    input,
    "help_command",
    async function replyToHelpCommand(ctx) {
      await handleTelegramHelpRequest(ctx, input, "command");
    },
  ));

  bot.command("status", createLoggedTelegramHandler(
    input,
    "status_command",
    async function replyToStatusCommand(ctx) {
      await handleTelegramStatusRequest(ctx, input, "command");
    },
  ));

  bot.command("cancel", createLoggedTelegramHandler(
    input,
    "cancel_command",
    async function replyToCancelCommand(ctx) {
      await handleTelegramCancelRequest(ctx, input, "command");
    },
  ));

  bot.callbackQuery(/^depix:(confirm|cancel|status|help)$/u, createLoggedTelegramHandler(
    input,
    "inline_action_reply",
    async function replyToInlineAction(ctx) {
      await handleTelegramInlineAction(ctx, input);
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
        const normalizedText = normalizeTelegramDecisionText(ctx.msg.text);

        if (isTelegramRestartDecision(normalizedText)) {
          await handleTelegramRestartRequest(ctx, input, "text");
          return;
        }

        if (isTelegramCancellationDecision(normalizedText)) {
          await handleTelegramCancelRequest(ctx, input, "text");
          return;
        }

        const orderSession = await startTelegramConversationOrder(ctx, input);

        if (orderSession.chatBinding?.blocked) {
          await ctx.reply(buildTelegramChatBindingBlockedReply());
          return;
        }

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

          await replyTelegramOrderStep(ctx, input.tenant, amountSession.order);
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

          await replyTelegramOrderStep(ctx, input.tenant, walletSession.order);
          return;
        }

        if (
          orderSession.order.currentStep === ORDER_PROGRESS_STATES.CONFIRMATION
          || orderSession.order.currentStep === ORDER_PROGRESS_STATES.CREATING_DEPOSIT
        ) {
          if (isTelegramConfirmationDecision(normalizedText)) {
            await handleTelegramConfirmRequest(ctx, input, orderSession.order, "text");
            return;
          }

          await replyTelegramConfirmationPrompt(ctx, orderSession.order);
          return;
        }

        await replyTelegramOrderStep(ctx, input.tenant, orderSession.order);
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
 * Mensagem de ajuda do bot Telegram.
 *
 * `/help` e deliberadamente um comando somente informativo: ele pode ler o
 * pedido aberto para contextualizar a resposta, mas nunca deve criar pedido,
 * chamar Eulen, confirmar deposito, cancelar, reiniciar ou alterar qualquer
 * coluna persistida. Isso preserva o contrato operacional de que ajuda nao e
 * uma acao de negocio.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @param {{ currentStep?: unknown, amountInCents?: unknown, walletAddress?: unknown } | null} order Pedido aberto, quando existir.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramHelpReply(tenant, order) {
  const header = `Ajuda do bot ${tenant.displayName} da DePix.`;
  const generalGuidance = [
    "Envie /start para começar uma compra de DePix com Pix.",
    "Depois informe o valor em BRL, por exemplo: 100,00.",
    "Quando o bot pedir, cole seu endereço DePix/Liquid. Aceito endereços começando com lq1 ou ex1.",
    "Use /status para consultar o pedido atual ou o último pedido relevante sem alterar nada.",
    "Para cancelar um pedido aberto, envie /cancel. Para recomeçar, envie recomecar.",
  ];

  if (!order) {
    return [
      header,
      ...generalGuidance,
    ].join("\n\n");
  }

  return [
    header,
    buildTelegramCurrentStepHelp(order),
    ...generalGuidance,
  ].join("\n\n");
}

/**
 * Mensagem de status do pedido atual ou mais recente do usuario.
 *
 * O texto e deliberadamente diagnostico e nao transacional: `/status` nao deve
 * parecer uma nova etapa do fluxo nem induzir o usuario a reenviar dados quando
 * o pedido ja esta terminal. Dados de pagamento sao limitados ao pedido do
 * mesmo tenant/usuario/canal ja selecionado pelo service de leitura.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @param {{ currentStep?: unknown, status?: unknown, amountInCents?: unknown, orderId?: unknown } | null} order Pedido selecionado para consulta.
 * @param {{ qrCopyPaste?: unknown, expiration?: unknown } | null} deposit Deposito associado ao pedido, quando existir.
 * @returns {string} Texto final para o usuario.
 */
export function buildTelegramStatusReply(tenant, order, deposit = null) {
  if (!order) {
    return [
      `Nao encontrei pedido recente em ${tenant.displayName}.`,
      "Envie /start para começar uma compra de DePix com Pix.",
    ].join("\n\n");
  }

  const amountLine = Number.isSafeInteger(order.amountInCents)
    ? `Valor: ${formatBrlAmountInCents(order.amountInCents)}`
    : "Valor: ainda nao informado";
  const statusLine = typeof order.status === "string" && order.status.length > 0
    ? `Status interno: ${order.status}`
    : "Status interno: nao informado";
  const header = `Status do seu pedido em ${tenant.displayName}.`;

  switch (order.currentStep) {
    case ORDER_PROGRESS_STATES.AMOUNT:
      return [
        header,
        amountLine,
        statusLine,
        "Proximo passo: envie o valor em BRL, por exemplo 100,00.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.WALLET:
      return [
        header,
        amountLine,
        statusLine,
        "Proximo passo: envie seu endereço DePix/Liquid começando com lq1 ou ex1.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.CONFIRMATION:
      return [
        header,
        amountLine,
        statusLine,
        "Proximo passo: confirme com sim, confirmar ou ok.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.CREATING_DEPOSIT:
      return [
        header,
        amountLine,
        statusLine,
        "Estou criando seu Pix. Aguarde um instante antes de reenviar a confirmação.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.AWAITING_PAYMENT:
      return buildTelegramAwaitingPaymentStatusReply({
        header,
        amountLine,
        statusLine,
        deposit,
      });
    case ORDER_PROGRESS_STATES.COMPLETED:
      return [
        header,
        amountLine,
        statusLine,
        order.status === "paid"
          ? "Pagamento concluído. Obrigado por usar a DePix."
          : "Este pedido foi encerrado. Se precisar comprar novamente, envie /start.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.FAILED:
      return [
        header,
        amountLine,
        statusLine,
        "Este pedido falhou. Envie /start para tentar novamente.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.CANCELED:
      return [
        header,
        amountLine,
        statusLine,
        "Este pedido foi cancelado. Envie /start para começar outro.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.MANUAL_REVIEW:
      return [
        header,
        amountLine,
        statusLine,
        "Este pedido está em análise operacional. Evite reenviar dados; o time precisa revisar o caso.",
      ].join("\n");
    default:
      return [
        header,
        amountLine,
        statusLine,
        "Encontrei seu pedido, mas ele esta em um estado que nao pede acao sua agora.",
      ].join("\n");
  }
}

function buildTelegramInlineKeyboard(rows) {
  return {
    inline_keyboard: rows,
  };
}

function buildTelegramConfirmationReplyMarkup() {
  return buildTelegramInlineKeyboard([
    [
      {
        text: "Confirmar",
        callback_data: "depix:confirm",
      },
      {
        text: "Cancelar",
        callback_data: "depix:cancel",
      },
    ],
  ]);
}

function buildTelegramAwaitingPaymentReplyMarkup() {
  return buildTelegramInlineKeyboard([
    [
      {
        text: "Ver status",
        callback_data: "depix:status",
      },
      {
        text: "Ajuda",
        callback_data: "depix:help",
      },
    ],
  ]);
}

function buildTelegramReplyMarkupForOrder(order) {
  switch (order?.currentStep) {
    case ORDER_PROGRESS_STATES.CONFIRMATION:
    case ORDER_PROGRESS_STATES.CREATING_DEPOSIT:
      return buildTelegramConfirmationReplyMarkup();
    case ORDER_PROGRESS_STATES.AWAITING_PAYMENT:
      return buildTelegramAwaitingPaymentReplyMarkup();
    default:
      return undefined;
  }
}

function buildTelegramReplyOptionsForOrder(order) {
  const replyMarkup = buildTelegramReplyMarkupForOrder(order);

  return replyMarkup
    ? {
      reply_markup: replyMarkup,
    }
    : undefined;
}

async function replyTelegramOrderStep(ctx, tenant, order) {
  const options = buildTelegramReplyOptionsForOrder(order);
  await ctx.reply(buildTelegramOrderStepReply(tenant, order), options);
}

async function replyTelegramConfirmationPrompt(ctx, order) {
  await ctx.reply(buildTelegramConfirmationPrompt(order), {
    reply_markup: buildTelegramConfirmationReplyMarkup(),
  });
}

async function replyTelegramStatus(ctx, tenant, order, deposit = null) {
  const options = buildTelegramReplyOptionsForOrder(order);
  await ctx.reply(buildTelegramStatusReply(tenant, order, deposit), options);
}

/**
 * Monta a variante de `/status` para pedidos aguardando pagamento.
 *
 * O copia-e-cola so aparece quando ja existe deposito do mesmo pedido. Isso
 * evita inventar QR ou recuperar dado de outro agregado por conveniencia.
 *
 * @param {{ header: string, amountLine: string, statusLine: string, deposit?: { qrCopyPaste?: unknown, expiration?: unknown } | null }} input Partes ja normalizadas do texto.
 * @returns {string} Texto final para pedido em `awaiting_payment`.
 */
function buildTelegramAwaitingPaymentStatusReply(input) {
  const lines = [
    input.header,
    input.amountLine,
    input.statusLine,
    "Seu Pix ja foi gerado. Pague o QR/copia-e-cola enviado nesta conversa e aguarde a confirmação.",
  ];

  if (typeof input.deposit?.expiration === "string" && input.deposit.expiration.length > 0) {
    lines.push(`Expiracao informada pela cobranca: ${input.deposit.expiration}`);
  }

  if (typeof input.deposit?.qrCopyPaste === "string" && input.deposit.qrCopyPaste.length > 0) {
    lines.push("Pix copia e cola:");
    lines.push(input.deposit.qrCopyPaste);
  }

  return lines.join("\n");
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
 * Explica o passo atual sem reaproveitar prompts que possam parecer uma nova
 * instrucao de negocio.
 *
 * A copy de ajuda deve ser diagnostica: ela orienta o usuario, mas deixa claro
 * que o pedido continua exatamente no mesmo estado em que estava antes do
 * comando `/help`.
 *
 * @param {{ currentStep?: unknown, amountInCents?: unknown, walletAddress?: unknown }} order Pedido aberto.
 * @returns {string} Orientacao contextual do passo atual.
 */
function buildTelegramCurrentStepHelp(order) {
  switch (order?.currentStep) {
    case ORDER_PROGRESS_STATES.AMOUNT:
      return [
        "Seu pedido aberto está aguardando o valor.",
        "Envie somente o valor em BRL, como 10,50 ou R$ 10,50.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.WALLET:
      return [
        "Seu pedido aberto está aguardando o endereço DePix/Liquid.",
        "Cole o endereço da SideSwap começando com lq1 ou use um endereço ex1.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.CONFIRMATION:
      return [
        "Seu pedido aberto está aguardando confirmação.",
        "Envie sim, confirmar ou ok para criar o Pix. Envie cancelar para encerrar.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.CREATING_DEPOSIT:
      return [
        "Seu pedido já está criando o depósito Pix.",
        "Aguarde um instante e evite reenviar a confirmação.",
      ].join("\n");
    case ORDER_PROGRESS_STATES.AWAITING_PAYMENT:
      return [
        "Seu pedido já está aguardando pagamento.",
        "Use o QR code Pix ou o copia-e-cola mais recente enviado nesta conversa.",
      ].join("\n");
    default:
      return [
        "Encontrei um pedido aberto, mas ele está em um estado que não pede ação sua agora.",
        "Se precisar abandonar esse pedido, envie /cancel.",
      ].join("\n");
  }
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
 * Mensagem curta para reinicio bem sucedido da conversa.
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramRestartedReply(tenant) {
  return [
    "Pedido anterior cancelado.",
    "Vamos recomecar do inicio.",
    "",
    buildTelegramAmountPrompt(tenant),
  ].join("\n");
}

/**
 * Mensagem para reinicio parcial: o cancelamento ocorreu, mas o novo pedido
 * nao conseguiu ser aberto na mesma rodada.
 *
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramRestartFailedReply() {
  return [
    "Seu pedido anterior foi cancelado.",
    "Nao consegui abrir o novo pedido agora.",
    "Envie /start para recomecar com seguranca.",
  ].join("\n\n");
}

/**
 * Mensagem para tentativas de controle sem pedido aberto.
 *
 * @param {"cancel" | "restart"} action Acao pedida pelo usuario.
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramNoOpenOrderControlReply(action) {
  const actionLine = action === "restart"
    ? "Nao existe pedido aberto para recomecar."
    : "Nao existe pedido aberto para cancelar.";

  return [
    actionLine,
    "Envie /start para comecar um novo pedido.",
  ].join("\n\n");
}

/**
 * Mensagem segura para updates vindos de um chat diferente daquele que ficou
 * associado ao pedido.
 *
 * O bot nao tenta "corrigir" o destino automaticamente porque esse chat sera
 * usado por notificacoes assincronas de pagamento. Qualquer overwrite
 * silencioso poderia enviar uma confirmacao financeira para a superficie
 * errada.
 *
 * @returns {string} Texto final para o usuario.
 */
function buildTelegramChatBindingBlockedReply() {
  return [
    "Não consigo continuar este pedido por este chat.",
    "Use a conversa original do pedido ou cancele o pedido aberto antes de tentar de novo.",
  ].join("\n\n");
}

/**
 * Formata a expiracao do Pix para uma copy curta e deterministica.
 *
 * A copy precisa preservar o significado do timestamp upstream. Portanto, a
 * funcao nao reinterpreta o fuso para "hora local do bot"; ela apenas formata
 * a data/hora exatamente no offset informado pela Eulen. Se o valor vier num
 * formato fora do ISO esperado, a funcao faz fallback para o texto bruto em
 * vez de inventar uma conversao.
 *
 * @param {{ expiration?: unknown }} deposit Deposito criado na Eulen.
 * @returns {string | null} Linha pronta para o usuario ou `null` quando ausente.
 */
function buildTelegramDepositExpirationLine(deposit) {
  const expiration = typeof deposit?.expiration === "string"
    ? deposit.expiration.trim()
    : "";

  if (expiration.length === 0) {
    return null;
  }

  const isoMatch = expiration.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u,
  );

  if (!isoMatch) {
    return `Expiracao: ${expiration}.`;
  }

  const [, year, month, day, hour, minute, offset] = isoMatch;
  const offsetLabel = offset === "Z" ? "UTC" : `UTC${offset}`;

  return `Expiracao: ${day}/${month}/${year} ${hour}:${minute} (${offsetLabel}).`;
}

/**
 * Mensagem principal enviada quando o Pix foi criado com sucesso.
 *
 * O caption precisa resolver a UX minima da issue #135:
 * - confirmar valor e contexto do pedido
 * - orientar o uso do QR e do copia-e-cola
 * - registrar expiracao apenas quando a Eulen devolver esse dado
 * - indicar o proximo passo sem prometer um `/status` que ainda nao existe
 *
 * @param {{ displayName: string }} tenant Tenant atual.
 * @param {{ amountInCents?: unknown }} order Pedido confirmado.
 * @param {{ expiration?: unknown }} deposit Deposito criado na Eulen.
 * @returns {string} Texto curto de orientacao.
 */
function buildTelegramDepositReadyCaption(tenant, order, deposit) {
  const amountLine = Number.isSafeInteger(order?.amountInCents)
    ? `Valor: ${formatBrlAmountInCents(order.amountInCents)}`
    : "Valor: conforme pedido";
  const expirationLine = buildTelegramDepositExpirationLine(deposit);

  return [
    `Pedido confirmado em ${tenant.displayName}.`,
    amountLine,
    "Seu Pix ja foi gerado.",
    "Pague com o QR acima ou com o Pix copia e cola abaixo.",
    ...(expirationLine ? [expirationLine] : []),
    "Depois de pagar, aguarde a confirmacao do pedido.",
    "Se precisar revisar o proximo passo, envie /help.",
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
 * @param {{ qrImageUrl?: unknown, qrCopyPaste?: unknown, expiration?: unknown }} deposit Deposito criado.
 * @returns {Promise<void>} Promessa resolvida apos os envios.
 */
async function sendTelegramDepositReadyReply(ctx, tenant, order, deposit) {
  const caption = buildTelegramDepositReadyCaption(tenant, order, deposit);
  const copyPasteReply = buildTelegramPixCopyPasteReply(deposit);
  const awaitingPaymentReplyMarkup = buildTelegramAwaitingPaymentReplyMarkup();

  if (typeof deposit?.qrImageUrl === "string" && deposit.qrImageUrl.length > 0) {
    try {
      await ctx.replyWithPhoto(deposit.qrImageUrl, {
        caption,
        reply_markup: awaitingPaymentReplyMarkup,
      });
      await ctx.reply(copyPasteReply);
      return;
    } catch {
      await ctx.reply(caption, {
        reply_markup: awaitingPaymentReplyMarkup,
      });
      await ctx.reply(copyPasteReply);
      return;
    }
  }

  await ctx.reply(caption, {
    reply_markup: awaitingPaymentReplyMarkup,
  });
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
 * Detecta pedidos simples de reinicio da conversa.
 *
 * @param {string} normalizedText Texto ja normalizado.
 * @returns {boolean} Verdadeiro quando a mensagem pede recomeco.
 */
function isTelegramRestartDecision(normalizedText) {
  return normalizedText === "recomecar";
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
    "Se precisar de ajuda, envie /help.",
    "Para recomeçar um pedido aberto, envie recomecar.",
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
    "Nesta fase eu respondo a mensagens de texto e aos comandos /start, /help, /status e /cancel.",
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
  const telegramChatId = resolveTelegramChatId(ctx, input.rawTelegramUpdate);

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

  if (telegramChatId === undefined) {
    throw new TelegramWebhookError(
      400,
      "telegram_order_registration_failed",
      "Telegram update does not expose a chat identifier for order registration.",
      {
        handlerName: ctx.state.telegramHandler,
        reason: "missing_telegram_chat_id",
      },
    );
  }

  const orderSession = await startTelegramOrderConversation({
    db: input.db,
    tenant: input.tenant,
    telegramUserId,
    telegramChatId,
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

  logTelegramChatBindingResult(ctx, input, orderSession);

  return orderSession;
}

/**
 * Resolve um pedido aberto existente sem criar um agregado novo.
 *
 * Isso e usado por comandos de controle. Sem essa leitura dedicada, um texto
 * como `cancelar` poderia acidentalmente criar um pedido novo em `amount`.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   db?: import("@cloudflare/workers-types").D1Database
 * }} input Contexto operacional do runtime.
 * @returns {Promise<Record<string, unknown> | null>} Pedido aberto atual, se existir.
 */
async function getExistingTelegramConversationOrder(ctx, input) {
  if (!input.db) {
    throw new TelegramWebhookError(
      500,
      "telegram_order_registration_failed",
      "Telegram order registration requires a configured database.",
      {
        handlerName: ctx.state?.telegramHandler,
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
        handlerName: ctx.state?.telegramHandler,
        reason: "missing_telegram_user_id",
      },
    );
  }

  return getTelegramOpenOrderForUser({
    db: input.db,
    tenant: input.tenant,
    telegramUserId,
  });
}

/**
 * Processa `/help` lendo apenas o pedido aberto atual.
 *
 * Este handler usa a mesma leitura segura dos comandos de controle, mas nao
 * chama nenhum service de transicao. Assim, o usuario pode pedir ajuda em
 * qualquer etapa sem risco de criar pedido novo, avançar estado, cancelar algo
 * por engano ou disparar integracao externa.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   db?: import("@cloudflare/workers-types").D1Database,
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {"command"} source Origem da intencao.
 * @returns {Promise<void>} Promessa resolvida apos a resposta ao usuario.
 */
async function handleTelegramHelpRequest(ctx, input, source) {
  const openOrder = await getExistingTelegramConversationOrder(ctx, input);

  logTelegramEvent(input, "info", "telegram.help.rendered", {
    handlerName: ctx.state?.telegramHandler,
    source,
    hasOpenOrder: Boolean(openOrder),
    orderId: openOrder?.orderId,
    currentStep: openOrder?.currentStep,
    status: openOrder?.status,
  });

  const options = buildTelegramReplyOptionsForOrder(openOrder);
  await ctx.reply(buildTelegramHelpReply(input.tenant, openOrder), options);
}

/**
 * Processa `/status` sem mutar o agregado conversacional.
 *
 * Diferente de `/start` e texto livre, este handler nunca chama o caminho de
 * materializacao de pedido. Ele seleciona o pedido aberto ou o ultimo pedido
 * relevante do mesmo usuario e, quando aplicavel, le o deposito desse pedido
 * apenas para repetir o Pix copia-e-cola ja associado ao agregado.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   db?: import("@cloudflare/workers-types").D1Database,
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {"command"} source Origem da intencao.
 * @returns {Promise<void>} Promessa resolvida apos a resposta ao usuario.
 */
async function handleTelegramStatusRequest(ctx, input, source) {
  if (!input.db) {
    throw new TelegramWebhookError(
      500,
      "telegram_order_registration_failed",
      "Telegram order status requires a configured database.",
      {
        handlerName: ctx.state?.telegramHandler,
        reason: "missing_database_context",
      },
    );
  }

  const telegramUserId = resolveTelegramActorId(ctx);

  if (telegramUserId === undefined) {
    throw new TelegramWebhookError(
      400,
      "telegram_order_registration_failed",
      "Telegram update does not expose a user identifier for order status.",
      {
        handlerName: ctx.state?.telegramHandler,
        reason: "missing_telegram_user_id",
      },
    );
  }

  const selection = await getTelegramRelevantOrderForUser({
    db: input.db,
    tenant: input.tenant,
    telegramUserId,
  });
  const deposit = selection.order
    ? await getLatestDepositByOrderId(input.db, input.tenant.tenantId, String(selection.order.orderId))
    : null;
  const reconciled = await reconcileTelegramAwaitingPaymentOrder(ctx, input, selection.order, deposit, "status");

  logTelegramEvent(input, "info", "telegram.status.rendered", {
    handlerName: ctx.state?.telegramHandler,
    source,
    selectionSource: selection.source,
    hasOrder: Boolean(reconciled.order),
    orderId: reconciled.order?.orderId,
    currentStep: reconciled.order?.currentStep,
    status: reconciled.order?.status,
    hasDeposit: Boolean(reconciled.deposit),
    depositEntryId: reconciled.deposit?.depositEntryId,
    recheckAttempted: reconciled.attempted,
    recheckCode: reconciled.result?.code,
  });

  await replyTelegramStatus(ctx, input.tenant, reconciled.order, reconciled.deposit);
}

async function handleTelegramConfirmRequest(ctx, input, order, source) {
  try {
    const confirmationSession = await confirmTelegramOrder({
      env: input.env,
      db: input.db,
      tenant: input.tenant,
      runtimeConfig: input.runtimeConfig,
      order,
    });

    logTelegramConfirmationDecision(ctx, input, "confirm", confirmationSession.order, {
      accepted: confirmationSession.accepted,
      conflict: confirmationSession.conflict,
      depositEntryId: confirmationSession.deposit?.depositEntryId,
      source,
    });

    if (confirmationSession.deposit) {
      await sendTelegramDepositReadyReply(ctx, input.tenant, confirmationSession.order, confirmationSession.deposit);
      return;
    }

    await replyTelegramOrderStep(ctx, input.tenant, confirmationSession.order);
  } catch (error) {
    if (error instanceof TelegramOrderConfirmationError) {
      logTelegramConfirmationFailure(ctx, input, order, error);
      await ctx.reply(error.userMessage);
      return;
    }

    throw error;
  }
}

async function readLatestDepositForTelegramOrder(input, order) {
  if (!input.db || !order?.orderId) {
    return null;
  }

  return getLatestDepositByOrderId(input.db, input.tenant.tenantId, String(order.orderId));
}

function canRecheckTelegramAwaitingPayment(order, deposit) {
  return order?.currentStep === ORDER_PROGRESS_STATES.AWAITING_PAYMENT
    && typeof deposit?.depositEntryId === "string"
    && deposit.depositEntryId.trim().length > 0;
}

async function reconcileTelegramAwaitingPaymentOrder(ctx, input, order, deposit, source) {
  if (!canRecheckTelegramAwaitingPayment(order, deposit)) {
    return {
      order,
      deposit,
      attempted: false,
      result: null,
    };
  }

  try {
    const eulenApiToken = await readTenantSecret(input.env, input.tenant, "eulenApiToken");
    const result = await processDepositRecheck({
      db: input.db,
      runtimeConfig: input.runtimeConfig,
      tenant: input.tenant,
      eulenApiToken,
      rawBody: JSON.stringify({
        depositEntryId: deposit.depositEntryId,
      }),
      requestId: input.requestContext?.requestId,
    });
    const [updatedOrder, updatedDeposit] = await Promise.all([
      getOrderById(input.db, input.tenant.tenantId, String(order.orderId)),
      readLatestDepositForTelegramOrder(input, order),
    ]);

    logTelegramEvent(input, "info", "telegram.deposit_recheck.completed", {
      handlerName: ctx.state?.telegramHandler,
      source,
      orderId: order.orderId,
      depositEntryId: deposit.depositEntryId,
      code: result.code,
      externalStatus: result.details.externalStatus,
      orderCurrentStep: result.details.orderCurrentStep,
      orderStatus: result.details.orderStatus,
    });

    return {
      order: updatedOrder ?? order,
      deposit: updatedDeposit ?? deposit,
      attempted: true,
      result,
    };
  } catch (error) {
    logTelegramEvent(input, "warn", "telegram.deposit_recheck.failed", {
      handlerName: ctx.state?.telegramHandler,
      source,
      orderId: order.orderId,
      depositEntryId: deposit.depositEntryId,
      code: typeof error?.code === "string" ? error.code : error?.name ?? "telegram_deposit_recheck_failed",
      message: error instanceof Error ? error.message : String(error),
    });

    return {
      order,
      deposit,
      attempted: true,
      result: null,
    };
  }
}

/**
 * Processa um cancelamento explicito do usuario.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   db?: import("@cloudflare/workers-types").D1Database,
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {"command" | "text"} source Origem da intencao.
 * @returns {Promise<void>} Promessa resolvida apos a resposta ao usuario.
 */
async function handleTelegramCancelRequest(ctx, input, source) {
  const openOrder = await getExistingTelegramConversationOrder(ctx, input);

  if (!openOrder) {
    logTelegramEvent(input, "info", "telegram.order.cancel_ignored", {
      handlerName: ctx.state?.telegramHandler,
      source,
      reason: "no_open_order",
    });
    await ctx.reply(buildTelegramNoOpenOrderControlReply("cancel"));
    return;
  }

  const canceledSession = await cancelTelegramOpenOrder({
    db: input.db,
    tenant: input.tenant,
    order: openOrder,
  });

  logTelegramConfirmationDecision(ctx, input, "cancel", canceledSession.order, {
    accepted: canceledSession.accepted,
    conflict: canceledSession.conflict,
    source,
  });

  if (canceledSession.accepted) {
    await ctx.reply(buildTelegramCanceledReply());
    return;
  }

  await replyTelegramOrderStep(ctx, input.tenant, canceledSession.order);
}

/**
 * Processa um reinicio explicito da conversa atual.
 *
 * O reinicio so avanca quando o pedido aberto pode ser cancelado primeiro.
 * Em qualquer outro estado, a resposta cai de volta para o estado atual.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{
 *   tenant: { tenantId: string, displayName: string },
 *   db?: import("@cloudflare/workers-types").D1Database,
 *   runtimeConfig?: Record<string, unknown>,
 *   requestContext?: {
 *     requestId?: string,
 *     method?: string,
 *     path?: string
 *   }
 * }} input Contexto operacional do runtime.
 * @param {"text"} source Origem da intencao.
 * @returns {Promise<void>} Promessa resolvida apos a resposta ao usuario.
 */
async function handleTelegramRestartRequest(ctx, input, source) {
  if (!input.db) {
    throw new TelegramWebhookError(
      500,
      "telegram_order_registration_failed",
      "Telegram order registration requires a configured database.",
      {
        handlerName: ctx.state?.telegramHandler,
        reason: "missing_database_context",
      },
    );
  }

  const telegramUserId = resolveTelegramActorId(ctx);
  const telegramChatId = resolveTelegramChatId(ctx, input.rawTelegramUpdate);

  if (telegramUserId === undefined) {
    throw new TelegramWebhookError(
      400,
      "telegram_order_registration_failed",
      "Telegram update does not expose a user identifier for order registration.",
      {
        handlerName: ctx.state?.telegramHandler,
        reason: "missing_telegram_user_id",
      },
    );
  }

  if (telegramChatId === undefined) {
    throw new TelegramWebhookError(
      400,
      "telegram_order_registration_failed",
      "Telegram update does not expose a chat identifier for order restart.",
      {
        handlerName: ctx.state?.telegramHandler,
        reason: "missing_telegram_chat_id",
      },
    );
  }

  const restartedSession = await restartTelegramOpenOrderConversation({
    db: input.db,
    tenant: input.tenant,
    telegramUserId,
    telegramChatId,
  });

  if (!restartedSession.previousOrder) {
    logTelegramEvent(input, "info", "telegram.order.restart_ignored", {
      handlerName: ctx.state?.telegramHandler,
      source,
      reason: "no_open_order",
    });
    await ctx.reply(buildTelegramNoOpenOrderControlReply("restart"));
    return;
  }

  logTelegramEvent(input, "info", "telegram.order.restart_handled", {
    handlerName: ctx.state?.telegramHandler,
    source,
    accepted: restartedSession.restarted,
    previousOrderId: restartedSession.previousOrder.orderId,
    nextOrderId: restartedSession.order?.orderId,
    currentStep: restartedSession.order?.currentStep ?? restartedSession.previousOrder.currentStep,
    status: restartedSession.order?.status ?? restartedSession.previousOrder.status,
    restartFailed: restartedSession.restartFailed,
    restartFailureReason: restartedSession.restartFailureReason,
  });

  if (restartedSession.restartFailed) {
    await ctx.reply(buildTelegramRestartFailedReply());
    return;
  }

  if (!restartedSession.restarted || !restartedSession.order) {
    await replyTelegramOrderStep(ctx, input.tenant, restartedSession.previousOrder);
    return;
  }

  await ctx.reply(buildTelegramRestartedReply(input.tenant));
}

async function handleTelegramInlineAction(ctx, input) {
  const action = String(ctx.callbackQuery?.data ?? "").slice("depix:".length);

  switch (action) {
    case "help":
      await ctx.answerCallbackQuery({
        text: "Ajuda atualizada.",
      });
      await handleTelegramHelpRequest(ctx, input, "callback");
      return;
    case "status":
      await ctx.answerCallbackQuery({
        text: "Status atualizado.",
      });
      await handleTelegramStatusRequest(ctx, input, "callback");
      return;
    case "cancel":
      await ctx.answerCallbackQuery({
        text: "Cancelando pedido.",
      });
      await handleTelegramCancelRequest(ctx, input, "callback");
      return;
    case "confirm": {
      const openOrder = await getExistingTelegramConversationOrder(ctx, input);

      if (!openOrder) {
        await ctx.answerCallbackQuery({
          text: "Nao encontrei pedido aberto.",
        });
        await ctx.reply(buildTelegramAmountPrompt(input.tenant));
        return;
      }

      if (
        openOrder.currentStep !== ORDER_PROGRESS_STATES.CONFIRMATION
        && openOrder.currentStep !== ORDER_PROGRESS_STATES.CREATING_DEPOSIT
      ) {
        await ctx.answerCallbackQuery({
          text: "Pedido ja atualizado.",
        });
        await replyTelegramOrderStep(ctx, input.tenant, openOrder);
        return;
      }

      await ctx.answerCallbackQuery({
        text: "Confirmando pedido.",
      });
      await handleTelegramConfirmRequest(ctx, input, openOrder, "callback");
      return;
    }
    default:
      await ctx.answerCallbackQuery({
        text: buildTelegramUnsupportedCallbackReply(input.tenant),
      });
  }
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
 * Registra apenas os resultados de binding de chat que precisam de observacao
 * operacional.
 *
 * Replays idempotentes e criacoes felizes nao geram ruido. Divergencia e
 * conflito transitorio, por outro lado, precisam aparecer nos logs porque
 * protegem o destino futuro das notificacoes assincronas de pagamento.
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
 * @param {{ order: Record<string, unknown>, chatBinding?: Record<string, unknown> }} orderSession Sessao materializada.
 */
function logTelegramChatBindingResult(ctx, input, orderSession) {
  const chatBinding = orderSession.chatBinding;

  if (!chatBinding?.blocked) {
    return;
  }

  const isMismatch = chatBinding.result === "telegram_chat_id_mismatch";
  const message = isMismatch
    ? "telegram.order.chat_divergence_detected"
    : "telegram.order.chat_hydration_conflict";

  logTelegramEvent(input, "warn", message, {
    handlerName: ctx.state.telegramHandler,
    orderId: orderSession.order.orderId,
    userId: orderSession.order.userId,
    currentStep: orderSession.order.currentStep,
    status: orderSession.order.status,
    persistedTelegramChatId: chatBinding.persistedTelegramChatId,
    incomingTelegramChatId: chatBinding.incomingTelegramChatId,
    reason: chatBinding.result,
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
 * Resolve o chat do update conversacional atual.
 *
 * Esse valor e diferente do `from.id`: `from.id` identifica o usuario, enquanto
 * `chat.id` identifica a superficie onde respostas assincronas futuras devem
 * ser entregues. Persistir essa distincao evita assumir que chat privado sera
 * sempre o unico modo operacional do Telegram.
 *
 * @param {any} ctx Contexto atual do grammY.
 * @param {{ chatId?: string, parseFailed: boolean } | undefined} rawTelegramUpdate Metadados extraidos do corpo bruto.
 * @returns {string | number | undefined} Identificador do chat, quando existir.
 */
function resolveTelegramChatId(ctx, rawTelegramUpdate) {
  return rawTelegramUpdate?.chatId
    ?? ctx.chat?.id
    ?? ctx.message?.chat?.id
    ?? ctx.update?.message?.chat?.id
    ?? ctx.update?.callback_query?.message?.chat?.id
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
