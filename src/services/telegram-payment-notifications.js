/**
 * Notificacoes assincronas de pagamento no Telegram.
 *
 * Este service fecha a lacuna humana do MVP depois do QR:
 * - a persistencia financeira continua sendo a fonte de verdade
 * - webhook, recheck e fallback podem pedir notificacao sem conhecer Bot API
 * - falha outbound nunca desfaz a conciliacao financeira ja persistida
 *
 * A idempotencia e dirigida por transicao visivel de estado. Nao basta o
 * evento existir; o usuario so deve receber mensagem quando a forma do pedido
 * mudou para um estado relevante para a jornada humana.
 */
import { GrammyError, HttpError } from "grammy";

import { readTenantSecret } from "../config/tenants.js";
import { getDepositByDepositEntryId } from "../db/repositories/deposits-repository.js";
import { getOrderById } from "../db/repositories/orders-repository.js";
import { log } from "../lib/logger.js";
import { formatBrlAmountInCents } from "../telegram/brl-amount.js";
import { getTelegramRuntime } from "../telegram/runtime.js";

const NOTIFIABLE_EXTERNAL_STATUSES = new Set([
  "depix_sent",
  "under_review",
  "error",
  "expired",
  "canceled",
  "refunded",
]);

/**
 * Reduz o estado reconciliado a uma chave canonica de notificacao.
 *
 * @param {{
 *   externalStatus?: unknown,
 *   orderStatus?: unknown,
 *   orderCurrentStep?: unknown
 * }} input Estado a classificar.
 * @returns {string | null} Chave logica da notificacao ou `null`.
 */
export function resolveTelegramNotificationKind(input) {
  const externalStatus = typeof input.externalStatus === "string"
    ? input.externalStatus
    : null;
  const orderStatus = typeof input.orderStatus === "string"
    ? input.orderStatus
    : null;
  const orderCurrentStep = typeof input.orderCurrentStep === "string"
    ? input.orderCurrentStep
    : null;

  switch (externalStatus) {
    case "depix_sent":
      return "payment_confirmed";
    case "under_review":
    case "error":
      return "manual_review";
    case "expired":
      return "expired";
    case "canceled":
      return "canceled";
    case "refunded":
      return "refunded";
    default:
      break;
  }

  if (orderStatus === "paid" || orderCurrentStep === "completed") {
    return "payment_confirmed";
  }

  if (orderStatus === "under_review" || orderCurrentStep === "manual_review") {
    return "manual_review";
  }

  if (orderStatus === "expired") {
    return "expired";
  }

  if (orderStatus === "canceled" || orderCurrentStep === "canceled") {
    return "canceled";
  }

  if (orderStatus === "refunded") {
    return "refunded";
  }

  return null;
}

/**
 * Decide se uma transicao reconciliada deve gerar mensagem Telegram.
 *
 * @param {{
 *   duplicate?: boolean,
 *   externalStatus?: unknown,
 *   orderStatus?: unknown,
 *   orderCurrentStep?: unknown,
 *   previousExternalStatus?: unknown,
 *   previousOrderStatus?: unknown,
 *   previousOrderCurrentStep?: unknown,
 *   order?: { channel?: unknown, telegramChatId?: unknown } | null
 * }} input Dados da transicao.
 * @returns {{ shouldNotify: boolean, reason: string, kind: string | null }} Decisao estruturada.
 */
export function classifyTelegramOrderNotification(input) {
  if (input.duplicate) {
    return {
      shouldNotify: false,
      reason: "duplicate_source_event",
      kind: null,
    };
  }

  if (!NOTIFIABLE_EXTERNAL_STATUSES.has(String(input.externalStatus ?? ""))) {
    return {
      shouldNotify: false,
      reason: "external_status_not_notifiable",
      kind: null,
    };
  }

  if (!input.order || input.order.channel !== "telegram") {
    return {
      shouldNotify: false,
      reason: "order_channel_not_telegram",
      kind: null,
    };
  }

  if (typeof input.order.telegramChatId !== "string" || input.order.telegramChatId.trim().length === 0) {
    return {
      shouldNotify: false,
      reason: "missing_telegram_chat_id",
      kind: null,
    };
  }

  const currentKind = resolveTelegramNotificationKind({
    externalStatus: input.externalStatus,
    orderStatus: input.orderStatus,
    orderCurrentStep: input.orderCurrentStep,
  });

  if (!currentKind) {
    return {
      shouldNotify: false,
      reason: "notification_kind_not_resolved",
      kind: null,
    };
  }

  const previousKind = resolveTelegramNotificationKind({
    externalStatus: input.previousExternalStatus,
    orderStatus: input.previousOrderStatus,
    orderCurrentStep: input.previousOrderCurrentStep,
  });

  if (previousKind === currentKind) {
    return {
      shouldNotify: false,
      reason: "visible_state_unchanged",
      kind: currentKind,
    };
  }

  return {
    shouldNotify: true,
    reason: "visible_state_changed",
    kind: currentKind,
  };
}

/**
 * Monta a mensagem final ao usuario.
 *
 * @param {{
 *   tenant: { displayName: string },
 *   order: { amountInCents?: unknown },
 *   kind: string
 * }} input Dados da mensagem.
 * @returns {string} Texto final.
 */
export function buildTelegramOrderNotificationMessage(input) {
  const amountLine = Number.isSafeInteger(input.order.amountInCents)
    ? `Valor: ${formatBrlAmountInCents(input.order.amountInCents)}.`
    : null;

  switch (input.kind) {
    case "payment_confirmed":
      return [
        `Pagamento confirmado em ${input.tenant.displayName}.`,
        amountLine,
        "Seu pedido foi concluído com sucesso.",
      ].filter(Boolean).join("\n\n");
    case "manual_review":
      return [
        `Recebemos uma atualização do seu pedido em ${input.tenant.displayName}.`,
        "O pagamento foi para revisão manual.",
        "Se precisar, fale com o suporte antes de abrir um novo pedido.",
      ].join("\n\n");
    case "expired":
      return [
        `O QR do pedido em ${input.tenant.displayName} expirou.`,
        "Envie /start para gerar um novo pedido.",
      ].join("\n\n");
    case "canceled":
      return [
        `O pedido em ${input.tenant.displayName} foi cancelado.`,
        "Envie /start se quiser iniciar um novo pedido.",
      ].join("\n\n");
    case "refunded":
      return [
        `O pedido em ${input.tenant.displayName} foi marcado como reembolsado.`,
        "Se precisar, fale com o suporte antes de gerar um novo pedido.",
      ].join("\n\n");
    default:
      return [
        `Recebemos uma atualização do seu pedido em ${input.tenant.displayName}.`,
        "Fale com o suporte se precisar de ajuda.",
      ].join("\n\n");
  }
}

/**
 * Resume um erro outbound do Telegram em shape seguro de log.
 *
 * @param {unknown} error Erro capturado no `sendMessage`.
 * @returns {{ code: string, details: Record<string, unknown> }} Codigo e detalhes redigidos.
 */
function summarizeTelegramNotificationError(error) {
  if (error instanceof GrammyError) {
    return {
      code: "telegram_outbound_request_failed",
      details: {
        method: error.method,
        errorCode: error.error_code,
        description: error.description,
      },
    };
  }

  if (error instanceof HttpError) {
    return {
      code: "telegram_outbound_transport_failed",
      details: {
        cause: error.error instanceof Error ? error.error.message : String(error.error),
      },
    };
  }

  return {
    code: "telegram_notification_failed",
    details: {
      cause: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Carrega o agregado local necessario para a notificacao.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenantId: string,
 *   orderId: string,
 *   depositEntryId?: string | null
 * }} input IDs reconciliados.
 * @returns {Promise<{ order: Record<string, unknown> | null, deposit: Record<string, unknown> | null }>} Snapshot local.
 */
async function readTelegramNotificationAggregate(input) {
  const [order, deposit] = await Promise.all([
    getOrderById(input.db, input.tenantId, input.orderId),
    input.depositEntryId
      ? getDepositByDepositEntryId(input.db, input.tenantId, input.depositEntryId)
      : Promise.resolve(null),
  ]);

  return { order, deposit };
}

/**
 * Tenta enviar uma notificacao Telegram para uma transicao financeira.
 *
 * @param {{
 *   env: Record<string, unknown>,
 *   db: import("@cloudflare/workers-types").D1Database,
 *   runtimeConfig: Record<string, unknown>,
 *   tenant: { tenantId: string, displayName: string, secretBindings?: Record<string, string> },
 *   requestContext?: { requestId?: string, method?: string, path?: string },
 *   orderId?: unknown,
 *   depositEntryId?: unknown,
 *   duplicate?: boolean,
 *   externalStatus?: unknown,
 *   orderStatus?: unknown,
 *   orderCurrentStep?: unknown,
 *   previousExternalStatus?: unknown,
 *   previousOrderStatus?: unknown,
 *   previousOrderCurrentStep?: unknown
 * }} input Contexto da transicao.
 * @returns {Promise<{ delivered: boolean, skipped: boolean, failed: boolean, reason: string, kind?: string | null }>} Resultado estruturado.
 */
export async function notifyTelegramOrderTransition(input) {
  if (typeof input.orderId !== "string" || input.orderId.trim().length === 0) {
    return {
      delivered: false,
      skipped: true,
      failed: false,
      reason: "missing_order_id",
      kind: null,
    };
  }

  const aggregate = await readTelegramNotificationAggregate({
    db: input.db,
    tenantId: input.tenant.tenantId,
    orderId: input.orderId,
    depositEntryId: typeof input.depositEntryId === "string" ? input.depositEntryId : null,
  });
  const decision = classifyTelegramOrderNotification({
    duplicate: input.duplicate,
    externalStatus: input.externalStatus,
    orderStatus: input.orderStatus,
    orderCurrentStep: input.orderCurrentStep,
    previousExternalStatus: input.previousExternalStatus,
    previousOrderStatus: input.previousOrderStatus,
    previousOrderCurrentStep: input.previousOrderCurrentStep,
    order: aggregate.order,
  });

  if (!decision.shouldNotify || !aggregate.order) {
    log(input.runtimeConfig, {
      level: "info",
      message: "telegram.payment_notification.skipped",
      tenantId: input.tenant.tenantId,
      requestId: input.requestContext?.requestId,
      details: {
        orderId: input.orderId,
        depositEntryId: typeof input.depositEntryId === "string" ? input.depositEntryId : null,
        externalStatus: input.externalStatus ?? null,
        orderStatus: input.orderStatus ?? null,
        orderCurrentStep: input.orderCurrentStep ?? null,
        reason: decision.reason,
      },
    });

    return {
      delivered: false,
      skipped: true,
      failed: false,
      reason: decision.reason,
      kind: decision.kind,
    };
  }

  let telegramBotToken;

  try {
    telegramBotToken = await readTenantSecret(input.env, input.tenant, "telegramBotToken");
  } catch (error) {
    log(input.runtimeConfig, {
      level: "error",
      message: "telegram.payment_notification.failed",
      tenantId: input.tenant.tenantId,
      requestId: input.requestContext?.requestId,
      details: {
        orderId: input.orderId,
        depositEntryId: typeof input.depositEntryId === "string" ? input.depositEntryId : null,
        reason: "telegram_bot_token_unavailable",
        cause: error instanceof Error ? error.message : String(error),
      },
    });

    return {
      delivered: false,
      skipped: false,
      failed: true,
      reason: "telegram_bot_token_unavailable",
      kind: decision.kind,
    };
  }

  const bot = getTelegramRuntime(input.tenant).createBot(telegramBotToken, {
    env: input.env,
    runtimeConfig: input.runtimeConfig,
    db: input.db,
    requestContext: input.requestContext,
  });
  const message = buildTelegramOrderNotificationMessage({
    tenant: input.tenant,
    order: aggregate.order,
    kind: decision.kind,
  });

  try {
    await bot.api.sendMessage(aggregate.order.telegramChatId, message);

    log(input.runtimeConfig, {
      level: "info",
      message: "telegram.payment_notification.sent",
      tenantId: input.tenant.tenantId,
      requestId: input.requestContext?.requestId,
      details: {
        orderId: input.orderId,
        depositEntryId: typeof input.depositEntryId === "string" ? input.depositEntryId : null,
        externalStatus: input.externalStatus ?? null,
        orderStatus: input.orderStatus ?? null,
        orderCurrentStep: input.orderCurrentStep ?? null,
        telegramChatId: aggregate.order.telegramChatId,
        kind: decision.kind,
      },
    });

    return {
      delivered: true,
      skipped: false,
      failed: false,
      reason: "delivered",
      kind: decision.kind,
    };
  } catch (error) {
    const summarizedError = summarizeTelegramNotificationError(error);

    log(input.runtimeConfig, {
      level: "error",
      message: "telegram.payment_notification.failed",
      tenantId: input.tenant.tenantId,
      requestId: input.requestContext?.requestId,
      details: {
        orderId: input.orderId,
        depositEntryId: typeof input.depositEntryId === "string" ? input.depositEntryId : null,
        externalStatus: input.externalStatus ?? null,
        orderStatus: input.orderStatus ?? null,
        orderCurrentStep: input.orderCurrentStep ?? null,
        telegramChatId: aggregate.order.telegramChatId,
        kind: decision.kind,
        code: summarizedError.code,
        ...summarizedError.details,
      },
    });

    return {
      delivered: false,
      skipped: false,
      failed: true,
      reason: summarizedError.code,
      kind: decision.kind,
    };
  }
}
