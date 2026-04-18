/**
 * Recheck operacional de deposito via `deposit-status`.
 *
 * Esta camada implementa o fallback manual mais direto do MVP:
 * - recebe um `depositEntryId` local
 * - consulta a verdade remota na Eulen
 * - hidrata `qrId` quando necessario
 * - persiste um evento de reconciliacao rastreavel
 * - aplica a verdade reconciliada em `deposits` e `orders`
 *
 * O objetivo aqui e complementar o webhook principal, nao substitui-lo.
 */
import { EulenApiError, getEulenDepositStatus, resolveEulenAsyncResponse } from "../clients/eulen-client.js";
import { createDepositEvent, listDepositEventsByDepositEntryId } from "../db/repositories/deposit-events-repository.js";
import { getDepositByDepositEntryId, getDepositByQrId, updateDepositByDepositEntryId } from "../db/repositories/deposits-repository.js";
import { getOrderById } from "../db/repositories/orders-repository.js";
import { log } from "../lib/logger.js";
import {
  applyWebhookTruthToAggregate,
  DepositCorrelationError,
  isLikelyUniqueConstraintError,
  normalizeEulenDepositStatusPayload,
} from "./eulen-deposit-webhook.js";

const RECHECK_DEPOSIT_STATUS_SOURCE = "recheck_deposit_status";

/**
 * Erro controlado do service de recheck.
 */
export class DepositRecheckError extends Error {
  /**
   * @param {number} status Status HTTP esperado na borda.
   * @param {string} code Codigo estavel.
   * @param {string} message Mensagem principal.
   * @param {Record<string, unknown>=} details Metadados adicionais.
   * @param {unknown} [cause] Erro original.
   */
  constructor(status, code, message, details = {}, cause) {
    super(message, { cause });
    this.name = "DepositRecheckError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Faz o parse seguro do corpo da rota de recheck.
 *
 * @param {string} rawBody Corpo textual recebido.
 * @returns {Record<string, unknown>} JSON parseado.
 */
export function parseDepositRecheckBody(rawBody) {
  if (!rawBody || rawBody.trim().length === 0) {
    return {};
  }

  try {
    const parsedBody = JSON.parse(rawBody);

    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new DepositRecheckError(400, "invalid_recheck_payload", "Recheck body must be a JSON object.");
    }

    return parsedBody;
  } catch (error) {
    if (error instanceof DepositRecheckError) {
      throw error;
    }

    throw new DepositRecheckError(400, "invalid_recheck_payload", "Recheck body must be valid JSON.");
  }
}

/**
 * Resolve e valida o `depositEntryId` alvo do recheck.
 *
 * A ancora local do fluxo de reconciliacao e o `depositEntryId`, porque ele
 * existe desde o `POST /deposit` e nao depende do webhook ter chegado.
 *
 * @param {Record<string, unknown>} body JSON do request.
 * @returns {string} `depositEntryId` pronto para uso.
 */
export function readDepositEntryIdFromRecheckBody(body) {
  const depositEntryId = typeof body.depositEntryId === "string"
    ? body.depositEntryId.trim()
    : typeof body.id === "string"
      ? body.id.trim()
      : "";

  if (!depositEntryId) {
    throw new DepositRecheckError(
      400,
      "deposit_entry_id_required",
      "Recheck payload must include depositEntryId.",
    );
  }

  return depositEntryId;
}

/**
 * Monta um raw payload deterministico para o evento de recheck.
 *
 * @param {{ depositEntryId: string, remoteStatus: { qrId?: string, status?: string, expiration?: string } }} input Dados reconciliados.
 * @returns {string} JSON estavel para trilha de auditoria e idempotencia.
 */
function buildDepositRecheckEventPayload(input) {
  return JSON.stringify({
    source: RECHECK_DEPOSIT_STATUS_SOURCE,
    depositEntryId: input.depositEntryId,
    remoteStatus: {
      qrId: input.remoteStatus.qrId ?? null,
      status: input.remoteStatus.status ?? null,
      expiration: input.remoteStatus.expiration ?? null,
    },
  });
}

/**
 * Detecta se um recheck equivalente ja foi persistido antes.
 *
 * @param {Record<string, unknown>[]} savedEvents Historico do deposito.
 * @param {{ externalStatus: string, rawPayload: string }} incomingEvent Evento atual.
 * @returns {Record<string, unknown> | undefined} Evento equivalente ja salvo.
 */
function findDuplicateRecheckEvent(savedEvents, incomingEvent) {
  return savedEvents.find((savedEvent) => (
    savedEvent.source === RECHECK_DEPOSIT_STATUS_SOURCE
    && savedEvent.externalStatus === incomingEvent.externalStatus
    && savedEvent.rawPayload === incomingEvent.rawPayload
  ));
}

/**
 * Decide se o agregado local ainda diverge da verdade remota.
 *
 * @param {Record<string, unknown>} deposit Deposito atual.
 * @param {Record<string, unknown>} order Pedido atual.
 * @param {{ qrId?: string, status?: string, expiration?: string }} remoteStatus Verdade remota reduzida.
 * @returns {boolean} Verdadeiro quando ainda ha algo para reparar.
 */
function shouldRepairAggregateFromRemoteStatus(deposit, order, remoteStatus) {
  return (
    (remoteStatus.status && deposit.externalStatus !== remoteStatus.status)
    || (remoteStatus.qrId && deposit.qrId !== remoteStatus.qrId)
    || (remoteStatus.expiration && deposit.expiration !== remoteStatus.expiration)
    || (
      remoteStatus.status === "depix_sent"
      && (order.status !== "paid" || order.currentStep !== "completed")
    )
  );
}

/**
 * Hidrata `qrId` e metadados de deposito sem sobrescrever outro agregado.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {Record<string, unknown>} deposit Deposito alvo.
 * @param {{ qrId?: string, expiration?: string, status?: string }} remoteStatus Verdade remota reduzida.
 * @returns {Promise<Record<string, unknown>>} Deposito atualizado ou original.
 */
async function hydrateDepositFromRemoteStatus(db, tenantId, deposit, remoteStatus) {
  if (!remoteStatus.qrId && !remoteStatus.expiration && !remoteStatus.status) {
    return deposit;
  }

  if (
    remoteStatus.qrId
    && deposit.qrId
    && deposit.qrId !== remoteStatus.qrId
    && deposit.qrId !== deposit.depositEntryId
  ) {
    throw new DepositCorrelationError(
      "deposit_qr_id_mismatch",
      "Remote qrId does not match the local deposit correlation.",
      {
        depositEntryId: deposit.depositEntryId,
        localQrId: deposit.qrId,
        remoteQrId: remoteStatus.qrId,
      },
    );
  }

  if (remoteStatus.qrId) {
    const conflictingDeposit = await getDepositByQrId(db, tenantId, remoteStatus.qrId);

    if (conflictingDeposit && conflictingDeposit.depositEntryId !== deposit.depositEntryId) {
      throw new DepositCorrelationError(
        "deposit_qr_id_conflict",
        "Remote qrId is already attached to another local deposit.",
        {
          depositEntryId: deposit.depositEntryId,
          remoteQrId: remoteStatus.qrId,
          conflictingDepositEntryId: conflictingDeposit.depositEntryId,
        },
      );
    }
  }

  const hydratedDeposit = await updateDepositByDepositEntryId(db, tenantId, deposit.depositEntryId, {
    ...(remoteStatus.qrId ? { qrId: remoteStatus.qrId } : {}),
    ...(remoteStatus.expiration ? { expiration: remoteStatus.expiration } : {}),
    ...(remoteStatus.status ? { externalStatus: remoteStatus.status } : {}),
  });

  return hydratedDeposit ?? deposit;
}

/**
 * Consulta a verdade remota na Eulen para o deposito alvo.
 *
 * @param {{
 *   runtimeConfig: { eulenApiBaseUrl: string, eulenApiTimeoutMs: number },
 *   tenant: { tenantId: string, eulenPartnerId?: string },
 *   eulenApiToken: string,
 *   depositEntryId: string
 * }} input Dependencias remotas.
 * @returns {Promise<{ qrId?: string, status?: string, expiration?: string }>} Status remoto reduzido.
 */
async function readRemoteDepositStatus(input) {
  const response = await getEulenDepositStatus(input.runtimeConfig, {
    apiToken: input.eulenApiToken,
    partnerId: input.tenant.eulenPartnerId,
  }, {
    id: input.depositEntryId,
    asyncMode: "false",
  });
  const resolvedResponse = await resolveEulenAsyncResponse(response);
  const remoteStatus = normalizeEulenDepositStatusPayload(resolvedResponse.data);

  if (!remoteStatus.status) {
    throw new DepositRecheckError(
      502,
      "deposit_status_invalid_response",
      "Eulen deposit-status did not return a usable status.",
      {
        depositEntryId: input.depositEntryId,
      },
    );
  }

  return remoteStatus;
}

/**
 * Executa o recheck operacional via `deposit-status`.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   runtimeConfig: { eulenApiBaseUrl: string, eulenApiTimeoutMs: number },
 *   tenant: { tenantId: string, eulenPartnerId?: string },
 *   eulenApiToken: string,
 *   rawBody: string,
 *   requestId?: string
 * }} input Dependencias e dados do request.
 * @returns {Promise<{
 *   ok: true,
 *   status: number,
 *   code: string,
 *   details: Record<string, unknown>
 * }>} Resultado normalizado para a borda HTTP.
 */
export async function processDepositRecheck(input) {
  const body = parseDepositRecheckBody(input.rawBody);
  const depositEntryId = readDepositEntryIdFromRecheckBody(body);
  const deposit = await getDepositByDepositEntryId(input.db, input.tenant.tenantId, depositEntryId);

  if (!deposit) {
    throw new DepositRecheckError(
      404,
      "deposit_not_found",
      `No deposit matches depositEntryId ${depositEntryId}.`,
      {
        depositEntryId,
      },
    );
  }

  const order = await getOrderById(input.db, input.tenant.tenantId, deposit.orderId);

  if (!order) {
    throw new DepositRecheckError(
      409,
      "order_not_found",
      "Deposit exists locally but its order aggregate is missing.",
      {
        depositEntryId,
        orderId: deposit.orderId,
      },
    );
  }

  let remoteStatus;

  try {
    remoteStatus = await readRemoteDepositStatus({
      runtimeConfig: input.runtimeConfig,
      tenant: input.tenant,
      eulenApiToken: input.eulenApiToken,
      depositEntryId,
    });
  } catch (error) {
    if (error instanceof DepositRecheckError) {
      throw error;
    }

    if (error instanceof EulenApiError) {
      throw new DepositRecheckError(
        502,
        "deposit_status_unavailable",
        "Could not read Eulen deposit-status for this deposit.",
        {
          depositEntryId,
          cause: error.details,
        },
        error,
      );
    }

    throw error;
  }

  let hydratedDeposit;

  try {
    hydratedDeposit = await hydrateDepositFromRemoteStatus(
      input.db,
      input.tenant.tenantId,
      deposit,
      remoteStatus,
    );
  } catch (error) {
    if (error instanceof DepositCorrelationError) {
      throw new DepositRecheckError(409, error.code, error.message, error.details, error);
    }

    throw error;
  }

  const eventPayload = buildDepositRecheckEventPayload({
    depositEntryId,
    remoteStatus,
  });
  const incomingEvent = {
    externalStatus: remoteStatus.status,
    rawPayload: eventPayload,
  };

  let savedEvent;
  let updatedDeposit = hydratedDeposit;
  let updatedOrder = order;
  let duplicate = false;
  let repairedAggregate = false;

  try {
    savedEvent = await createDepositEvent(input.db, {
      tenantId: input.tenant.tenantId,
      orderId: hydratedDeposit.orderId,
      depositEntryId: hydratedDeposit.depositEntryId,
      qrId: hydratedDeposit.qrId ?? remoteStatus.qrId ?? null,
      source: RECHECK_DEPOSIT_STATUS_SOURCE,
      externalStatus: remoteStatus.status,
      bankTxId: null,
      blockchainTxId: null,
      rawPayload: eventPayload,
    });
  } catch (error) {
    if (!isLikelyUniqueConstraintError(error)) {
      throw error;
    }

    duplicate = true;

    const savedEvents = await listDepositEventsByDepositEntryId(input.db, input.tenant.tenantId, hydratedDeposit.depositEntryId);
    const duplicateEvent = findDuplicateRecheckEvent(savedEvents, incomingEvent);

    if (!duplicateEvent) {
      throw error;
    }

    if (shouldRepairAggregateFromRemoteStatus(hydratedDeposit, order, remoteStatus)) {
      ({ updatedDeposit, updatedOrder } = await applyWebhookTruthToAggregate(
        input.db,
        input.tenant.tenantId,
        hydratedDeposit,
        order,
        remoteStatus.status,
      ));
      repairedAggregate = true;
    }

    log(input.runtimeConfig, {
      level: "info",
      message: repairedAggregate ? "ops.deposit_recheck.duplicate_repaired" : "ops.deposit_recheck.duplicate_ignored",
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      details: {
        depositEntryId,
        orderId: order.orderId,
        qrId: hydratedDeposit.qrId ?? remoteStatus.qrId,
        externalStatus: remoteStatus.status,
        eventId: duplicateEvent.id,
      },
    });

    return {
      ok: true,
      status: 200,
      code: "deposit_recheck_duplicate",
      details: {
        duplicate,
        repairedAggregate,
        source: RECHECK_DEPOSIT_STATUS_SOURCE,
        eventId: duplicateEvent.id,
        depositEntryId: updatedDeposit?.depositEntryId ?? hydratedDeposit.depositEntryId,
        qrId: updatedDeposit?.qrId ?? hydratedDeposit.qrId ?? remoteStatus.qrId,
        orderId: updatedOrder?.orderId ?? order.orderId,
        externalStatus: remoteStatus.status,
        orderStatus: updatedOrder?.status ?? order.status,
        orderCurrentStep: updatedOrder?.currentStep ?? order.currentStep,
      },
    };
  }

  ({ updatedDeposit, updatedOrder } = await applyWebhookTruthToAggregate(
    input.db,
    input.tenant.tenantId,
    hydratedDeposit,
    order,
    remoteStatus.status,
  ));

  log(input.runtimeConfig, {
    level: "info",
    message: "ops.deposit_recheck.processed",
    tenantId: input.tenant.tenantId,
    requestId: input.requestId,
    details: {
      depositEntryId,
      orderId: order.orderId,
      qrId: updatedDeposit?.qrId ?? hydratedDeposit.qrId ?? remoteStatus.qrId,
      externalStatus: remoteStatus.status,
      eventId: savedEvent?.id,
    },
  });

  return {
    ok: true,
    status: 200,
    code: "deposit_recheck_processed",
    details: {
      duplicate,
      repairedAggregate,
      source: RECHECK_DEPOSIT_STATUS_SOURCE,
      eventId: savedEvent?.id,
      depositEntryId: updatedDeposit?.depositEntryId ?? hydratedDeposit.depositEntryId,
      qrId: updatedDeposit?.qrId ?? hydratedDeposit.qrId ?? remoteStatus.qrId,
      orderId: updatedOrder?.orderId ?? order.orderId,
      externalStatus: remoteStatus.status,
      orderStatus: updatedOrder?.status ?? order.status,
      orderCurrentStep: updatedOrder?.currentStep ?? order.currentStep,
    },
  };
}
