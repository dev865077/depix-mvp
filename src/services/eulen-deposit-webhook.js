/**
 * Servico de ingestao do webhook principal de deposito da Eulen.
 *
 * Esta camada concentra:
 * - validacao do segredo do webhook
 * - validacao do payload recebido
 * - idempotencia para redelivery
 * - aplicacao minima da verdade externa em deposits e orders
 */
import { createDepositEvent, listDepositEventsByDepositId } from "../db/repositories/deposit-events-repository.js";
import { getDepositById, updateDepositById } from "../db/repositories/deposits-repository.js";
import { getOrderById, updateOrderById } from "../db/repositories/orders-repository.js";
import { log } from "../lib/logger.js";

const WEBHOOK_SOURCE = "webhook";
const EULEN_TERMINAL_ORDER_STEPS = new Set(["completed"]);

/**
 * Compara duas strings de forma deterministica sem abortar cedo.
 *
 * @param {string} left Primeiro valor.
 * @param {string} right Segundo valor.
 * @returns {boolean} Verdadeiro quando os valores sao equivalentes.
 */
export function safeEqualString(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length === rightBytes.length ? 0 : 1;

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return mismatch === 0;
}

/**
 * Verifica se o header Authorization da Eulen bate com o segredo configurado.
 *
 * A documentacao da Eulen mostra o formato `Authorization: Basic <secret>`.
 * Tambem aceitamos o formato Basic convencional com `username:password`
 * codificado em Base64, desde que o `password` coincida com o segredo.
 *
 * @param {string | undefined} authorizationHeader Header bruto recebido.
 * @param {string} expectedSecret Segredo esperado para o tenant.
 * @returns {boolean} Verdadeiro quando o header e valido.
 */
export function isValidEulenAuthorizationHeader(authorizationHeader, expectedSecret) {
  if (!authorizationHeader || typeof authorizationHeader !== "string") {
    return false;
  }

  const [scheme, credentials] = authorizationHeader.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "basic" || !credentials) {
    return false;
  }

  if (safeEqualString(credentials, expectedSecret)) {
    return true;
  }

  try {
    const decodedCredentials = atob(credentials);
    const separatorIndex = decodedCredentials.indexOf(":");
    const password = separatorIndex >= 0 ? decodedCredentials.slice(separatorIndex + 1) : decodedCredentials;

    return safeEqualString(password, expectedSecret);
  } catch {
    return false;
  }
}

/**
 * Mapeia um status externo para o patch minimo do pedido interno.
 *
 * @param {string} externalStatus Status vindo da Eulen.
 * @returns {Record<string, string>} Patch de order.
 */
export function mapOrderPatchFromExternalStatus(externalStatus) {
  switch (externalStatus) {
    case "depix_sent":
      return {
        status: "paid",
        currentStep: "completed",
      };
    case "pending":
      return {
        status: "pending",
        currentStep: "awaiting_payment",
      };
    case "under_review":
      return {
        status: "under_review",
        currentStep: "manual_review",
      };
    case "error":
      return {
        status: "error",
        currentStep: "manual_review",
      };
    case "expired":
      return {
        status: "expired",
        currentStep: "completed",
      };
    case "canceled":
      return {
        status: "canceled",
        currentStep: "completed",
      };
    case "refunded":
      return {
        status: "refunded",
        currentStep: "completed",
      };
    default:
      return {
        status: externalStatus,
      };
  }
}

/**
 * Faz o parse seguro do corpo do webhook.
 *
 * @param {string} rawBody Corpo textual recebido.
 * @returns {{ payload?: Record<string, unknown>, error?: string }} Resultado do parse.
 */
export function parseEulenWebhookPayload(rawBody) {
  if (!rawBody || rawBody.trim().length === 0) {
    return {
      error: "Webhook body is required.",
    };
  }

  try {
    const payload = JSON.parse(rawBody);

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {
        error: "Webhook body must be a JSON object.",
      };
    }

    return {
      payload,
    };
  } catch {
    return {
      error: "Webhook body must be valid JSON.",
    };
  }
}

/**
 * Normaliza o payload de deposito para o formato que o app realmente usa.
 *
 * @param {Record<string, unknown>} payload Objeto recebido do webhook.
 * @returns {{ qrId?: string, status?: string, partnerId?: string, bankTxId?: string, blockchainTxId?: string, webhookType?: string }} Payload reduzido.
 */
export function normalizeEulenDepositPayload(payload) {
  return {
    webhookType: typeof payload.webhookType === "string" ? payload.webhookType.trim() : undefined,
    qrId: typeof payload.qrId === "string" ? payload.qrId.trim() : undefined,
    status: typeof payload.status === "string" ? payload.status.trim() : undefined,
    partnerId: typeof payload.partnerId === "string" ? payload.partnerId.trim() : undefined,
    bankTxId: typeof payload.bankTxId === "string" ? payload.bankTxId.trim() : undefined,
    blockchainTxId: typeof payload.blockchainTxID === "string"
      ? payload.blockchainTxID.trim()
      : typeof payload.blockchainTxId === "string"
        ? payload.blockchainTxId.trim()
        : undefined,
  };
}

/**
 * Verifica se o evento recebido ja foi persistido anteriormente.
 *
 * @param {Record<string, unknown>[]} savedEvents Eventos ja registrados para o deposito.
 * @param {{ externalStatus: string, bankTxId?: string, blockchainTxId?: string, rawPayload: string }} incomingEvent Evento atual.
 * @returns {Record<string, unknown> | undefined} Evento duplicado encontrado.
 */
export function findDuplicateWebhookEvent(savedEvents, incomingEvent) {
  return savedEvents.find((savedEvent) => (
    savedEvent.source === WEBHOOK_SOURCE
    && savedEvent.externalStatus === incomingEvent.externalStatus
    && (savedEvent.bankTxId ?? null) === (incomingEvent.bankTxId ?? null)
    && (savedEvent.blockchainTxId ?? null) === (incomingEvent.blockchainTxId ?? null)
    && savedEvent.rawPayload === incomingEvent.rawPayload
  ));
}

/**
 * Heuristica minima para reconhecer falha de unicidade do SQLite/D1.
 *
 * @param {unknown} error Erro capturado durante a persistencia.
 * @returns {boolean} Verdadeiro quando o erro parece ser de unicidade.
 */
export function isLikelyUniqueConstraintError(error) {
  const message = String(error?.message ?? error ?? "");

  return /unique/i.test(message) || /constraint failed/i.test(message);
}

/**
 * Decide se vale sobrescrever o currentStep atual do pedido.
 *
 * @param {Record<string, unknown>} order Pedido atual.
 * @param {Record<string, string>} patch Patch calculado.
 * @returns {Record<string, string>} Patch final para persistencia.
 */
export function reconcileOrderPatch(order, patch) {
  if (!patch.currentStep) {
    return patch;
  }

  if (typeof order.currentStep === "string" && EULEN_TERMINAL_ORDER_STEPS.has(order.currentStep) && patch.currentStep !== "completed") {
    const { currentStep, ...rest } = patch;

    return rest;
  }

  return patch;
}

/**
 * Aplica a verdade externa atual no agregado interno do pedido.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {Record<string, unknown>} deposit Deposito atual.
 * @param {Record<string, unknown>} order Pedido atual.
 * @param {string} externalStatus Status vindo da Eulen.
 * @returns {Promise<{ updatedDeposit: Record<string, unknown> | null, updatedOrder: Record<string, unknown> | null }>} Agregado atualizado.
 */
export async function applyWebhookTruthToAggregate(db, tenantId, deposit, order, externalStatus) {
  const updatedDeposit = await updateDepositById(db, tenantId, deposit.depositId, {
    externalStatus,
  });
  const updatedOrder = await updateOrderById(
    db,
    tenantId,
    deposit.orderId,
    reconcileOrderPatch(order, mapOrderPatchFromExternalStatus(externalStatus)),
  );

  return {
    updatedDeposit,
    updatedOrder,
  };
}

/**
 * Decide se um evento duplicado ainda e o mais recente no historico.
 *
 * Quando o evento duplicado e o ultimo salvo, um retry pode reparar um fluxo
 * que falhou depois de gravar o dedupe marker e antes de atualizar o agregado.
 *
 * @param {Record<string, unknown> | undefined} duplicateEvent Evento duplicado encontrado.
 * @param {Record<string, unknown>[]} savedEvents Historico do deposito em ordem decrescente.
 * @returns {boolean} Verdadeiro quando o duplicado ainda e o evento mais recente.
 */
export function isLatestDuplicateEvent(duplicateEvent, savedEvents) {
  return Boolean(duplicateEvent && savedEvents[0]?.id === duplicateEvent.id);
}

/**
 * Processa o webhook principal de deposito da Eulen.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   runtimeConfig: Record<string, unknown>,
 *   tenant: { tenantId: string, eulenPartnerId?: string },
 *   authorizationHeader?: string,
 *   expectedSecret: string,
 *   rawBody: string,
 *   requestId?: string
 * }} input Dependencias e dados da chamada atual.
 * @returns {Promise<{
 *   ok: boolean,
 *   status: number,
 *   code: string,
 *   message: string,
 *   details?: Record<string, unknown>
 * }>} Resultado normalizado para a borda HTTP.
 */
export async function processEulenDepositWebhook(input) {
  if (!isValidEulenAuthorizationHeader(input.authorizationHeader, input.expectedSecret)) {
    log(input.runtimeConfig, {
      level: "warn",
      message: "webhook.eulen.secret_rejected",
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      details: {
        reason: input.authorizationHeader ? "invalid_authorization_header" : "missing_authorization_header",
      },
    });

    return {
      ok: false,
      status: 401,
      code: "invalid_webhook_secret",
      message: "Invalid Eulen webhook secret.",
    };
  }

  const parsedPayload = parseEulenWebhookPayload(input.rawBody);

  if (parsedPayload.error) {
    return {
      ok: false,
      status: 400,
      code: "invalid_webhook_payload",
      message: parsedPayload.error,
    };
  }

  const payload = normalizeEulenDepositPayload(parsedPayload.payload);

  if (payload.webhookType !== "deposit") {
    return {
      ok: false,
      status: 400,
      code: "unsupported_webhook_type",
      message: "Only deposit webhooks are supported on this route.",
      details: {
        webhookType: payload.webhookType,
      },
    };
  }

  if (!payload.qrId || !payload.status) {
    return {
      ok: false,
      status: 400,
      code: "invalid_webhook_payload",
      message: "Webhook payload must include qrId and status.",
    };
  }

  if (payload.partnerId && input.tenant.eulenPartnerId && payload.partnerId !== input.tenant.eulenPartnerId) {
    log(input.runtimeConfig, {
      level: "warn",
      message: "webhook.eulen.tenant_mismatch",
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      details: {
        expectedPartnerId: input.tenant.eulenPartnerId,
        receivedPartnerId: payload.partnerId,
      },
    });

    return {
      ok: false,
      status: 409,
      code: "tenant_mismatch",
      message: "Webhook partnerId does not match the tenant configuration.",
    };
  }

  const deposit = await getDepositById(input.db, input.tenant.tenantId, payload.qrId);

  if (!deposit) {
    return {
      ok: false,
      status: 404,
      code: "deposit_not_found",
      message: `No deposit matches qrId ${payload.qrId}.`,
    };
  }

  const order = await getOrderById(input.db, input.tenant.tenantId, deposit.orderId);

  if (!order) {
    throw new Error(`Missing order for deposit ${deposit.depositId}.`);
  }

  const incomingEvent = {
    externalStatus: payload.status,
    bankTxId: payload.bankTxId,
    blockchainTxId: payload.blockchainTxId,
    rawPayload: input.rawBody,
  };

  let savedEvent;

  try {
    savedEvent = await createDepositEvent(input.db, {
      tenantId: input.tenant.tenantId,
      orderId: deposit.orderId,
      depositId: deposit.depositId,
      source: WEBHOOK_SOURCE,
      externalStatus: payload.status,
      bankTxId: payload.bankTxId ?? null,
      blockchainTxId: payload.blockchainTxId ?? null,
      rawPayload: input.rawBody,
    });
  } catch (error) {
    if (!isLikelyUniqueConstraintError(error)) {
      throw error;
    }

    const savedEvents = await listDepositEventsByDepositId(input.db, input.tenant.tenantId, deposit.depositId);
    const duplicateEvent = findDuplicateWebhookEvent(savedEvents, incomingEvent);

    if (!duplicateEvent) {
      throw error;
    }

    let updatedDeposit = deposit;
    let updatedOrder = order;
    const repairedAggregate = isLatestDuplicateEvent(duplicateEvent, savedEvents);

    if (repairedAggregate) {
      const currentDeposit = await getDepositById(input.db, input.tenant.tenantId, deposit.depositId);
      const currentOrder = await getOrderById(input.db, input.tenant.tenantId, deposit.orderId);

      if (!currentDeposit) {
        throw new Error(`Missing deposit for duplicate event ${duplicateEvent.id}.`);
      }

      if (!currentOrder) {
        throw new Error(`Missing order for duplicate event ${duplicateEvent.id}.`);
      }

      ({ updatedDeposit, updatedOrder } = await applyWebhookTruthToAggregate(
        input.db,
        input.tenant.tenantId,
        currentDeposit,
        currentOrder,
        payload.status,
      ));
    }

    log(input.runtimeConfig, {
      level: "info",
      message: repairedAggregate ? "webhook.eulen.duplicate_repaired" : "webhook.eulen.duplicate_ignored",
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      details: {
        depositId: deposit.depositId,
        eventId: duplicateEvent.id,
        externalStatus: payload.status,
      },
    });

    return {
      ok: true,
      status: 200,
      code: "duplicate_webhook_ignored",
      message: repairedAggregate
        ? "Duplicate webhook reconciled from the latest persisted event."
        : "Duplicate webhook ignored.",
      details: {
        duplicate: true,
        repairedAggregate,
        eventId: duplicateEvent.id,
        depositId: updatedDeposit?.depositId ?? deposit.depositId,
        orderId: updatedOrder?.orderId ?? deposit.orderId,
        externalStatus: payload.status,
        orderStatus: updatedOrder?.status,
        orderCurrentStep: updatedOrder?.currentStep,
      },
    };
  }

  const { updatedDeposit, updatedOrder } = await applyWebhookTruthToAggregate(
    input.db,
    input.tenant.tenantId,
    deposit,
    order,
    payload.status,
  );

  log(input.runtimeConfig, {
    level: "info",
    message: "webhook.eulen.processed",
    tenantId: input.tenant.tenantId,
    requestId: input.requestId,
    details: {
      depositId: deposit.depositId,
      orderId: deposit.orderId,
      externalStatus: payload.status,
      eventId: savedEvent?.id,
    },
  });

  return {
    ok: true,
    status: 200,
    code: "webhook_processed",
    message: "Eulen deposit webhook processed successfully.",
    details: {
      duplicate: false,
      eventId: savedEvent?.id,
      depositId: updatedDeposit?.depositId ?? deposit.depositId,
      orderId: updatedOrder?.orderId ?? deposit.orderId,
      externalStatus: payload.status,
      orderStatus: updatedOrder?.status,
      orderCurrentStep: updatedOrder?.currentStep,
    },
  };
}
