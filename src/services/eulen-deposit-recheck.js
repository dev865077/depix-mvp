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
import {
  buildCreateDepositEventStatement,
  listDepositEventsByDepositEntryId,
} from "../db/repositories/deposit-events-repository.js";
import {
  buildSelectDepositByDepositEntryIdStatement,
  buildUpdateDepositByDepositEntryIdStatement,
  getDepositByDepositEntryId,
  getDepositByQrId,
} from "../db/repositories/deposits-repository.js";
import {
  buildSelectOrderByIdStatement,
  buildUpdateOrderByIdStatement,
  getOrderById,
} from "../db/repositories/orders-repository.js";
import { log } from "../lib/logger.js";
import {
  DepositCorrelationError,
  isLikelyUniqueConstraintError,
  mapOrderPatchFromExternalStatus,
  normalizeEulenDepositStatusPayload,
  reconcileOrderPatch,
} from "./eulen-deposit-webhook.js";

const RECHECK_DEPOSIT_STATUS_SOURCE = "recheck_deposit_status";
const NON_REGRESSIVE_COMPLETED_REMOTE_STATUSES = new Set(["depix_sent", "expired", "canceled"]);

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
 * @param {{ depositEntryId: string, remoteStatus: { bankTxId?: string, blockchainTxId?: string, qrId?: string, status?: string, expiration?: string } }} input Dados reconciliados.
 * @returns {string} JSON estavel para trilha de auditoria e idempotencia.
 */
function buildDepositRecheckEventPayload(input) {
  return JSON.stringify({
    source: RECHECK_DEPOSIT_STATUS_SOURCE,
    depositEntryId: input.depositEntryId,
    remoteStatus: {
      bankTxId: input.remoteStatus.bankTxId ?? null,
      blockchainTxId: input.remoteStatus.blockchainTxId ?? null,
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
 * @param {Record<string, unknown>} depositPatch Patch calculado para o deposito.
 * @param {Record<string, unknown>} orderPatch Patch calculado para o pedido.
 * @returns {boolean} Verdadeiro quando ainda ha algo para reparar.
 */
function shouldRepairAggregateFromRemoteStatus(depositPatch, orderPatch) {
  return Object.keys(depositPatch).length > 0 || Object.keys(orderPatch).length > 0;
}

/**
 * Decide se o agregado local ja representa um estado terminal concluido.
 *
 * O risco operacional principal do recheck e aceitar um `deposit-status`
 * regressivo e sobrescrever um agregado ja concluido localmente. Mantemos a
 * regra explicita aqui para que o service e a documentacao falem a mesma
 * lingua.
 *
 * @param {Record<string, unknown>} deposit Deposito atual.
 * @param {Record<string, unknown>} order Pedido atual.
 * @returns {boolean} Verdadeiro quando o agregado local ja esta concluido.
 */
function isCompletedLocalAggregate(deposit, order) {
  return (
    deposit.externalStatus === "depix_sent"
    || order.status === "paid"
    || order.currentStep === "completed"
  );
}

/**
 * Resolve o status remoto que pode ser aplicado sem regredir o agregado local.
 *
 * Politica operacional atual:
 * - `depix_sent` e o sinal remoto de liquidacao concluida
 * - uma vez que o agregado local esteja concluido, o recheck nao aceita um
 *   status remoto nao terminal inferior como fonte de verdade
 *
 * Isso evita que um `deposit-status` atrasado devolva `pending` e desfaça um
 * pedido que ja foi liquidado por webhook ou recheck anterior.
 *
 * @param {Record<string, unknown>} deposit Deposito atual.
 * @param {Record<string, unknown>} order Pedido atual.
 * @param {string} remoteExternalStatus Status remoto retornado pela Eulen.
 * @returns {string} Status remoto autorizado para aplicacao.
 */
function resolveRecheckExternalStatus(deposit, order, remoteExternalStatus) {
  if (
    isCompletedLocalAggregate(deposit, order)
    && !NON_REGRESSIVE_COMPLETED_REMOTE_STATUSES.has(remoteExternalStatus)
  ) {
    throw new DepositRecheckError(
      409,
      "deposit_status_regression",
      "Remote deposit-status would regress a completed local aggregate.",
      {
        depositEntryId: deposit.depositEntryId,
        localExternalStatus: deposit.externalStatus,
        localOrderStatus: order.status,
        localOrderCurrentStep: order.currentStep,
        remoteExternalStatus,
      },
    );
  }

  return remoteExternalStatus;
}

/**
 * Planeja o patch local de deposito sem escrever no banco ainda.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {Record<string, unknown>} deposit Deposito alvo.
 * @param {{ qrId?: string, expiration?: string, status?: string }} remoteStatus Verdade remota reduzida.
 * @returns {Promise<Record<string, unknown>>} Patch permitido para o deposito.
 */
async function planDepositHydrationFromRemoteStatus(db, tenantId, deposit, remoteStatus) {
  if (!remoteStatus.qrId && !remoteStatus.expiration && !remoteStatus.status) {
    return {};
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

  return {
    ...(remoteStatus.qrId && deposit.qrId !== remoteStatus.qrId ? { qrId: remoteStatus.qrId } : {}),
    ...(remoteStatus.expiration && deposit.expiration !== remoteStatus.expiration ? { expiration: remoteStatus.expiration } : {}),
  };
}

/**
 * Calcula o plano completo de reconciliacao local para um recheck.
 *
 * A borda de recheck precisa separar leitura remota de persistencia local.
 * Com isso, conseguimos validar conflito/precedencia antes de abrir a janela
 * de escrita e depois gravar evento + agregados no mesmo batch do D1.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {Record<string, unknown>} deposit Deposito atual.
 * @param {Record<string, unknown>} order Pedido atual.
 * @param {{ qrId?: string, expiration?: string, status?: string }} remoteStatus Verdade remota reduzida.
 * @returns {Promise<{
 *   appliedExternalStatus: string,
 *   depositPatch: Record<string, unknown>,
 *   orderPatch: Record<string, unknown>,
 *   resultingQrId: string | null | undefined
 * }>}
 */
async function planRecheckAggregateMutation(db, tenantId, deposit, order, remoteStatus) {
  const appliedExternalStatus = resolveRecheckExternalStatus(deposit, order, remoteStatus.status);
  const depositPatch = await planDepositHydrationFromRemoteStatus(db, tenantId, deposit, remoteStatus);

  if (deposit.externalStatus !== appliedExternalStatus) {
    depositPatch.externalStatus = appliedExternalStatus;
  }

  const orderPatch = reconcileOrderPatch(order, mapOrderPatchFromExternalStatus(appliedExternalStatus));
  const resultingQrId = depositPatch.qrId ?? deposit.qrId ?? remoteStatus.qrId ?? null;

  return {
    appliedExternalStatus,
    depositPatch,
    orderPatch,
    resultingQrId,
  };
}

/**
 * Persiste evento + deposito + order no mesmo batch do D1.
 *
 * A intencao aqui e manter trilha de auditoria e agregado sempre alinhados: se
 * qualquer passo falhar, o batch inteiro e abortado e nenhum write parcial deve
 * sobreviver.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositEntryId Deposito alvo.
 * @param {string} orderId Pedido alvo.
 * @param {Record<string, unknown>} eventInput Evento do recheck.
 * @param {Record<string, unknown>} depositPatch Patch do deposito.
 * @param {Record<string, unknown>} orderPatch Patch do pedido.
 * @returns {Promise<{
 *   savedEvent: Record<string, unknown> | null,
 *   updatedDeposit: Record<string, unknown> | null,
 *   updatedOrder: Record<string, unknown> | null
 * }>}
 */
async function persistDepositRecheckAtomically(db, tenantId, depositEntryId, orderId, eventInput, depositPatch, orderPatch) {
  const statements = [
    buildCreateDepositEventStatement(db, eventInput),
  ];
  const depositUpdateStatement = buildUpdateDepositByDepositEntryIdStatement(db, tenantId, depositEntryId, depositPatch);
  const orderUpdateStatement = buildUpdateOrderByIdStatement(db, tenantId, orderId, orderPatch);

  if (depositUpdateStatement) {
    statements.push(depositUpdateStatement);
  }

  if (orderUpdateStatement) {
    statements.push(orderUpdateStatement);
  }

  statements.push(
    buildSelectDepositByDepositEntryIdStatement(db, tenantId, depositEntryId),
    buildSelectOrderByIdStatement(db, tenantId, orderId),
  );

  const results = await db.batch(statements);
  const depositResult = results.at(-2);
  const orderResult = results.at(-1);
  const updatedDeposit = depositResult?.results?.[0] ?? null;
  const updatedOrder = orderResult?.results?.[0] ?? null;

  if (!updatedDeposit || !updatedOrder) {
    throw new DepositRecheckError(
      500,
      "deposit_recheck_persistence_incomplete",
      "Atomic recheck write completed without a readable aggregate snapshot.",
      {
        depositEntryId,
        orderId,
        mayHaveCommitted: true,
        safeToRetry: true,
        source: RECHECK_DEPOSIT_STATUS_SOURCE,
      },
    );
  }

  return {
    savedEvent: results[0]?.results?.[0] ?? null,
    updatedDeposit,
    updatedOrder,
  };
}

/**
 * Repara apenas o agregado local em um unico batch, sem tentar reinserir o
 * evento de auditoria que ja existe.
 *
 * Esse caminho existe para retries concorrentes ou para replays em cima de um
 * evento duplicado que ja foi persistido anteriormente.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositEntryId Deposito alvo.
 * @param {string} orderId Pedido alvo.
 * @param {Record<string, unknown>} depositPatch Patch do deposito.
 * @param {Record<string, unknown>} orderPatch Patch do pedido.
 * @returns {Promise<{
 *   updatedDeposit: Record<string, unknown> | null,
 *   updatedOrder: Record<string, unknown> | null
 * }>}
 */
async function persistAggregateRepairAtomically(db, tenantId, depositEntryId, orderId, depositPatch, orderPatch) {
  const statements = [];
  const depositUpdateStatement = buildUpdateDepositByDepositEntryIdStatement(db, tenantId, depositEntryId, depositPatch);
  const orderUpdateStatement = buildUpdateOrderByIdStatement(db, tenantId, orderId, orderPatch);

  if (depositUpdateStatement) {
    statements.push(depositUpdateStatement);
  }

  if (orderUpdateStatement) {
    statements.push(orderUpdateStatement);
  }

  statements.push(
    buildSelectDepositByDepositEntryIdStatement(db, tenantId, depositEntryId),
    buildSelectOrderByIdStatement(db, tenantId, orderId),
  );

  const results = await db.batch(statements);
  const depositResult = results.at(-2);
  const orderResult = results.at(-1);
  const updatedDeposit = depositResult?.results?.[0] ?? null;
  const updatedOrder = orderResult?.results?.[0] ?? null;

  if (!updatedDeposit || !updatedOrder) {
    throw new DepositRecheckError(
      500,
      "deposit_recheck_persistence_incomplete",
      "Aggregate repair completed without a readable aggregate snapshot.",
      {
        depositEntryId,
        orderId,
        mayHaveCommitted: true,
        safeToRetry: true,
        source: RECHECK_DEPOSIT_STATUS_SOURCE,
      },
    );
  }

  return {
    updatedDeposit,
    updatedOrder,
  };
}

/**
 * Consulta a verdade remota na Eulen para o deposito alvo.
 *
 * @param {{
 *   runtimeConfig: { eulenApiBaseUrl: string, eulenApiTimeoutMs: number },
 *   tenant: { tenantId: string, eulenPartnerId?: string },
 *   eulenApiToken: string,
 *   depositEntryId: string,
 *   correlationId?: string,
 *   orderId?: string,
 *   requestId?: string
 * }} input Dependencias remotas.
 * @returns {Promise<{ bankTxId?: string, blockchainTxId?: string, qrId?: string, status?: string, expiration?: string }>} Status remoto reduzido.
 */
async function readRemoteDepositStatus(input) {
  const response = await getEulenDepositStatus(input.runtimeConfig, {
    apiToken: input.eulenApiToken,
    partnerId: input.tenant.eulenPartnerId,
  }, {
    id: input.depositEntryId,
    asyncMode: "false",
    telemetry: {
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      correlationId: input.correlationId,
      operation: "deposit_recheck",
      orderId: input.orderId,
      depositEntryId: input.depositEntryId,
    },
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
      correlationId: order.correlationId,
      orderId: order.orderId,
      requestId: input.requestId,
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

  let mutationPlan;

  try {
    mutationPlan = await planRecheckAggregateMutation(
      input.db,
      input.tenant.tenantId,
      deposit,
      order,
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
    externalStatus: mutationPlan.appliedExternalStatus,
    rawPayload: eventPayload,
  };

  let savedEvent;
  let updatedDeposit = deposit;
  let updatedOrder = order;
  let duplicate = false;
  let repairedAggregate = false;

  try {
    ({ savedEvent, updatedDeposit, updatedOrder } = await persistDepositRecheckAtomically(
      input.db,
      input.tenant.tenantId,
      deposit.depositEntryId,
      deposit.orderId,
      {
        tenantId: input.tenant.tenantId,
        orderId: deposit.orderId,
        depositEntryId: deposit.depositEntryId,
        qrId: mutationPlan.resultingQrId,
        source: RECHECK_DEPOSIT_STATUS_SOURCE,
        externalStatus: mutationPlan.appliedExternalStatus,
        bankTxId: remoteStatus.bankTxId ?? null,
        blockchainTxId: remoteStatus.blockchainTxId ?? null,
        requestId: input.requestId ?? null,
        rawPayload: eventPayload,
      },
      mutationPlan.depositPatch,
      mutationPlan.orderPatch,
    ));
  } catch (error) {
    if (!isLikelyUniqueConstraintError(error)) {
      throw error;
    }

    duplicate = true;

    const savedEvents = await listDepositEventsByDepositEntryId(input.db, input.tenant.tenantId, deposit.depositEntryId);
    const duplicateEvent = findDuplicateRecheckEvent(savedEvents, incomingEvent);

    if (!duplicateEvent) {
      throw error;
    }

    const currentDeposit = await getDepositByDepositEntryId(input.db, input.tenant.tenantId, deposit.depositEntryId);
    const currentOrder = await getOrderById(input.db, input.tenant.tenantId, deposit.orderId);

    if (!currentDeposit || !currentOrder) {
      throw error;
    }

    const duplicateRepairPlan = await planRecheckAggregateMutation(
      input.db,
      input.tenant.tenantId,
      currentDeposit,
      currentOrder,
      remoteStatus,
    );

    if (shouldRepairAggregateFromRemoteStatus(duplicateRepairPlan.depositPatch, duplicateRepairPlan.orderPatch)) {
      ({ updatedDeposit, updatedOrder } = await persistAggregateRepairAtomically(
        input.db,
        input.tenant.tenantId,
        currentDeposit.depositEntryId,
        currentOrder.orderId,
        duplicateRepairPlan.depositPatch,
        duplicateRepairPlan.orderPatch,
      ));
      repairedAggregate = true;
    } else {
      updatedDeposit = currentDeposit;
      updatedOrder = currentOrder;
    }

    log(input.runtimeConfig, {
      level: "info",
      message: repairedAggregate ? "ops.deposit_recheck.duplicate_repaired" : "ops.deposit_recheck.duplicate_ignored",
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      details: {
        depositEntryId,
        orderId: order.orderId,
        qrId: updatedDeposit?.qrId ?? mutationPlan.resultingQrId,
        externalStatus: duplicateRepairPlan.appliedExternalStatus,
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
        depositEntryId: updatedDeposit?.depositEntryId ?? deposit.depositEntryId,
        qrId: updatedDeposit?.qrId ?? mutationPlan.resultingQrId,
        orderId: updatedOrder?.orderId ?? order.orderId,
        externalStatus: duplicateRepairPlan.appliedExternalStatus,
        previousExternalStatus: deposit.externalStatus,
        previousOrderStatus: order.status,
        previousOrderCurrentStep: order.currentStep,
        orderStatus: updatedOrder?.status ?? order.status,
        orderCurrentStep: updatedOrder?.currentStep ?? order.currentStep,
      },
    };
  }

  log(input.runtimeConfig, {
    level: "info",
    message: "ops.deposit_recheck.processed",
    tenantId: input.tenant.tenantId,
    requestId: input.requestId,
    details: {
      depositEntryId,
      orderId: order.orderId,
      qrId: updatedDeposit?.qrId ?? mutationPlan.resultingQrId,
      externalStatus: mutationPlan.appliedExternalStatus,
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
      depositEntryId: updatedDeposit?.depositEntryId ?? deposit.depositEntryId,
      qrId: updatedDeposit?.qrId ?? mutationPlan.resultingQrId,
      orderId: updatedOrder?.orderId ?? order.orderId,
      externalStatus: mutationPlan.appliedExternalStatus,
      previousExternalStatus: deposit.externalStatus,
      previousOrderStatus: order.status,
      previousOrderCurrentStep: order.currentStep,
      orderStatus: updatedOrder?.status ?? order.status,
      orderCurrentStep: updatedOrder?.currentStep ?? order.currentStep,
    },
  };
}
