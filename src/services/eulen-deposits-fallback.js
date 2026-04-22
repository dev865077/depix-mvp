/**
 * Fallback operacional de reconciliacao por janela usando `/deposits`.
 *
 * Este fluxo cobre o cenario em que o webhook atrasou ou nao chegou e o
 * operador precisa reconciliar uma janela curta sem consultar deposito por
 * deposito via `deposit-status`. A API `/deposits` retorna linhas compactas
 * ancoradas em `qrId`, portanto esta primeira versao segura reconcilia apenas
 * depositos locais que ja possuem `qrId` conhecido no tenant atual.
 */
import { EulenApiError, listEulenDeposits, resolveEulenAsyncResponse } from "../clients/eulen-client.js";
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
  isLikelyUniqueConstraintError,
  mapOrderPatchFromExternalStatus,
  reconcileOrderPatch,
} from "./eulen-deposit-webhook.js";

const DEPOSITS_LIST_SOURCE = "recheck_deposits_list";
const NON_REGRESSIVE_COMPLETED_REMOTE_STATUSES = new Set(["depix_sent", "expired", "canceled", "refunded"]);
export const DEPOSITS_FALLBACK_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEPOSITS_FALLBACK_MAX_REMOTE_ROWS = 200;

/**
 * Erro controlado do fallback por `/deposits`.
 */
export class DepositsFallbackError extends Error {
  /**
   * @param {number} status Status HTTP esperado na borda.
   * @param {string} code Codigo estavel.
   * @param {string} message Mensagem principal.
   * @param {Record<string, unknown>=} details Metadados seguros.
   * @param {unknown} [cause] Erro original.
   */
  constructor(status, code, message, details = {}, cause) {
    super(message, { cause });
    this.name = "DepositsFallbackError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Faz o parse seguro do corpo da rota de fallback por janela.
 *
 * @param {string} rawBody Corpo textual recebido.
 * @returns {Record<string, unknown>} JSON parseado.
 */
export function parseDepositsFallbackBody(rawBody) {
  if (!rawBody || rawBody.trim().length === 0) {
    return {};
  }

  try {
    const parsedBody = JSON.parse(rawBody);

    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new DepositsFallbackError(400, "invalid_deposits_fallback_payload", "Fallback body must be a JSON object.");
    }

    return parsedBody;
  } catch (error) {
    if (error instanceof DepositsFallbackError) {
      throw error;
    }

    throw new DepositsFallbackError(400, "invalid_deposits_fallback_payload", "Fallback body must be valid JSON.");
  }
}

/**
 * Le uma string obrigatoria do corpo da rota.
 *
 * @param {Record<string, unknown>} body Corpo parseado.
 * @param {string} field Campo esperado.
 * @returns {string} Valor textual limpo.
 */
function readRequiredBodyString(body, field) {
  const value = typeof body[field] === "string" ? body[field].trim() : "";

  if (!value) {
    throw new DepositsFallbackError(
      400,
      "deposits_fallback_window_required",
      "Fallback payload must include start and end window boundaries.",
      { field },
    );
  }

  return value;
}

/**
 * Converte uma fronteira temporal em timestamp validado.
 *
 * O fallback por janela e uma ferramenta operacional de baixo blast radius. Por
 * isso a borda local nao repassa datas malformadas para a Eulen: qualquer valor
 * que `Date.parse` nao reconheca falha antes de gerar chamada externa ou efeito
 * colateral em D1.
 *
 * @param {string} value Valor textual enviado no corpo.
 * @param {"start" | "end"} field Nome da fronteira validada.
 * @returns {number} Timestamp em milissegundos.
 */
function readWindowBoundaryTimestamp(value, field) {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    throw new DepositsFallbackError(
      400,
      "deposits_fallback_invalid_window",
      "Fallback window boundaries must be parseable dates.",
      { field, value },
    );
  }

  return timestamp;
}

/**
 * Normaliza a janela operacional enviada pelo operador.
 *
 * A API Eulen aceita `YYYY-MM-DD` ou RFC3339. Aqui exigimos datas parseaveis,
 * ordem crescente e janela maxima de 24h. Esse limite mantem a rota adequada
 * para reconciliacao manual curta, sem transformar um fallback em varredura
 * ampla de extrato remoto.
 *
 * @param {Record<string, unknown>} body Corpo parseado.
 * @returns {{ start: string, end: string, status?: string }} Janela validada.
 */
export function readDepositsFallbackWindow(body) {
  const start = readRequiredBodyString(body, "start");
  const end = readRequiredBodyString(body, "end");
  const status = typeof body.status === "string" && body.status.trim().length > 0
    ? body.status.trim()
    : undefined;
  const parsedStart = readWindowBoundaryTimestamp(start, "start");
  const parsedEnd = readWindowBoundaryTimestamp(end, "end");

  if (parsedStart >= parsedEnd) {
    throw new DepositsFallbackError(
      400,
      "deposits_fallback_invalid_window",
      "Fallback window start must be earlier than end.",
      { start, end },
    );
  }

  if (parsedEnd - parsedStart > DEPOSITS_FALLBACK_MAX_WINDOW_MS) {
    throw new DepositsFallbackError(
      400,
      "deposits_fallback_window_too_large",
      "Fallback window must be 24 hours or less.",
      {
        start,
        end,
        maxWindowHours: DEPOSITS_FALLBACK_MAX_WINDOW_MS / 60 / 60 / 1000,
      },
    );
  }

  return { start, end, status };
}

/**
 * Normaliza uma linha compacta retornada por `/deposits`.
 *
 * @param {unknown} row Linha remota.
 * @returns {{ qrId?: string, status?: string, bankTxId?: string, blockchainTxId?: string }} Linha reduzida.
 */
export function normalizeEulenDepositsListRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return {};
  }

  return {
    qrId: typeof row.qrId === "string" ? row.qrId.trim() : undefined,
    status: typeof row.status === "string" ? row.status.trim() : undefined,
    bankTxId: typeof row.bankTxId === "string" ? row.bankTxId.trim() : undefined,
    blockchainTxId: typeof row.blockchainTxID === "string"
      ? row.blockchainTxID.trim()
      : typeof row.blockchainTxId === "string"
        ? row.blockchainTxId.trim()
        : undefined,
  };
}

/**
 * Normaliza o envelope completo de `/deposits`.
 *
 * A documentacao mostra array direto, mas o client tambem precisa tolerar o
 * wrapper `response` usado por outros endpoints da Eulen.
 *
 * @param {unknown} payload Corpo resolvido da Eulen.
 * @returns {ReturnType<typeof normalizeEulenDepositsListRow>[]} Linhas validas.
 */
export function normalizeEulenDepositsListPayload(payload) {
  if (
    payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && "response" in payload
  ) {
    return normalizeEulenDepositsListPayload(payload.response);
  }

  if (!Array.isArray(payload)) {
    return [];
  }

  if (payload.length > DEPOSITS_FALLBACK_MAX_REMOTE_ROWS) {
    throw new DepositsFallbackError(
      502,
      "deposits_fallback_remote_row_limit_exceeded",
      "Eulen deposits response exceeded the supported reconciliation row limit.",
      {
        remoteRows: payload.length,
        maxRemoteRows: DEPOSITS_FALLBACK_MAX_REMOTE_ROWS,
      },
    );
  }

  return payload
    .map(normalizeEulenDepositsListRow)
    .filter((row) => row.qrId && row.status);
}

/**
 * Decide se o agregado local ja esta em estado terminal concluido.
 *
 * @param {Record<string, unknown>} deposit Deposito local.
 * @param {Record<string, unknown>} order Pedido local.
 * @returns {boolean} Verdadeiro quando uma verdade remota inferior nao deve aplicar.
 */
function isCompletedLocalAggregate(deposit, order) {
  return (
    deposit.externalStatus === "depix_sent"
    || order.status === "paid"
    || order.currentStep === "completed"
  );
}

/**
 * Remove campos que ja batem com o agregado local.
 *
 * Os builders de update sempre adicionam `updatedAt`; por isso o service deve
 * decidir antes se existe mudanca de negocio real. Sem essa filtragem, um
 * replay idempotente pareceria precisar de reparo apenas por remontar o mesmo
 * patch logico.
 *
 * @param {Record<string, unknown>} aggregate Registro local atual.
 * @param {Record<string, unknown>} patch Patch calculado.
 * @returns {Record<string, unknown>} Patch contendo apenas mudancas reais.
 */
function removeUnchangedPatchFields(aggregate, patch) {
  return Object.fromEntries(
    Object.entries(patch).filter(([field, value]) => aggregate[field] !== value),
  );
}

/**
 * Calcula patches seguros para aplicar uma linha de `/deposits`.
 *
 * @param {Record<string, unknown>} deposit Deposito local.
 * @param {Record<string, unknown>} order Pedido local.
 * @param {{ qrId?: string, status?: string }} remoteDeposit Linha remota.
 * @returns {{ depositPatch: Record<string, unknown>, orderPatch: Record<string, unknown>, skippedReason?: string }} Plano local.
 */
function planDepositsListAggregateMutation(deposit, order, remoteDeposit) {
  if (
    isCompletedLocalAggregate(deposit, order)
    && !NON_REGRESSIVE_COMPLETED_REMOTE_STATUSES.has(remoteDeposit.status)
  ) {
    return {
      depositPatch: {},
      orderPatch: {},
      skippedReason: "status_regression",
    };
  }

  const depositPatch = deposit.externalStatus === remoteDeposit.status
    ? {}
    : { externalStatus: remoteDeposit.status };
  const orderPatch = removeUnchangedPatchFields(
    order,
    reconcileOrderPatch(order, mapOrderPatchFromExternalStatus(remoteDeposit.status)),
  );

  return { depositPatch, orderPatch };
}

/**
 * Monta payload deterministico para o evento de fallback.
 *
 * @param {{ window: { start: string, end: string, status?: string }, remoteDeposit: Record<string, unknown> }} input Dados auditaveis.
 * @returns {string} JSON estavel para idempotencia.
 */
function buildDepositsListEventPayload(input) {
  return JSON.stringify({
    source: DEPOSITS_LIST_SOURCE,
    window: {
      start: input.window.start,
      end: input.window.end,
      status: input.window.status ?? null,
    },
    remoteDeposit: {
      qrId: input.remoteDeposit.qrId ?? null,
      status: input.remoteDeposit.status ?? null,
      bankTxId: input.remoteDeposit.bankTxId ?? null,
      blockchainTxId: input.remoteDeposit.blockchainTxId ?? null,
    },
  });
}

/**
 * Procura evento equivalente ja persistido para manter replay idempotente.
 *
 * @param {Record<string, unknown>[]} savedEvents Eventos locais.
 * @param {{ externalStatus: string, rawPayload: string, bankTxId?: string, blockchainTxId?: string }} incomingEvent Evento novo.
 * @returns {Record<string, unknown> | undefined} Evento duplicado.
 */
function findDuplicateDepositsListEvent(savedEvents, incomingEvent) {
  return savedEvents.find((savedEvent) => (
    savedEvent.source === DEPOSITS_LIST_SOURCE
    && savedEvent.externalStatus === incomingEvent.externalStatus
    && savedEvent.rawPayload === incomingEvent.rawPayload
    && (savedEvent.bankTxId ?? null) === (incomingEvent.bankTxId ?? null)
    && (savedEvent.blockchainTxId ?? null) === (incomingEvent.blockchainTxId ?? null)
  ));
}

/**
 * Persiste evento + agregado em um unico batch D1.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {Record<string, unknown>} eventInput Evento a gravar.
 * @param {Record<string, unknown>} deposit Deposito local.
 * @param {Record<string, unknown>} order Pedido local.
 * @param {Record<string, unknown>} depositPatch Patch de deposito.
 * @param {Record<string, unknown>} orderPatch Patch de pedido.
 * @returns {Promise<{ savedEvent: Record<string, unknown> | null, updatedDeposit: Record<string, unknown> | null, updatedOrder: Record<string, unknown> | null }>} Resultado.
 */
async function persistDepositsListReconciliationAtomically(db, tenantId, eventInput, deposit, order, depositPatch, orderPatch) {
  const statements = [buildCreateDepositEventStatement(db, eventInput)];
  const depositUpdateStatement = buildUpdateDepositByDepositEntryIdStatement(db, tenantId, deposit.depositEntryId, depositPatch);
  const orderUpdateStatement = buildUpdateOrderByIdStatement(db, tenantId, order.orderId, orderPatch);

  if (depositUpdateStatement) {
    statements.push(depositUpdateStatement);
  }

  if (orderUpdateStatement) {
    statements.push(orderUpdateStatement);
  }

  statements.push(
    buildSelectDepositByDepositEntryIdStatement(db, tenantId, deposit.depositEntryId),
    buildSelectOrderByIdStatement(db, tenantId, order.orderId),
  );

  const results = await db.batch(statements);

  return {
    savedEvent: results[0]?.results?.[0] ?? null,
    updatedDeposit: results.at(-2)?.results?.[0] ?? null,
    updatedOrder: results.at(-1)?.results?.[0] ?? null,
  };
}

/**
 * Repara apenas agregado local quando o evento de auditoria ja existe.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {Record<string, unknown>} deposit Deposito local.
 * @param {Record<string, unknown>} order Pedido local.
 * @param {Record<string, unknown>} depositPatch Patch de deposito.
 * @param {Record<string, unknown>} orderPatch Patch de pedido.
 * @returns {Promise<{ updatedDeposit: Record<string, unknown> | null, updatedOrder: Record<string, unknown> | null }>} Resultado.
 */
async function repairDepositsListAggregateAtomically(db, tenantId, deposit, order, depositPatch, orderPatch) {
  const statements = [];
  const depositUpdateStatement = buildUpdateDepositByDepositEntryIdStatement(db, tenantId, deposit.depositEntryId, depositPatch);
  const orderUpdateStatement = buildUpdateOrderByIdStatement(db, tenantId, order.orderId, orderPatch);

  if (depositUpdateStatement) {
    statements.push(depositUpdateStatement);
  }

  if (orderUpdateStatement) {
    statements.push(orderUpdateStatement);
  }

  statements.push(
    buildSelectDepositByDepositEntryIdStatement(db, tenantId, deposit.depositEntryId),
    buildSelectOrderByIdStatement(db, tenantId, order.orderId),
  );

  const results = await db.batch(statements);

  return {
    updatedDeposit: results.at(-2)?.results?.[0] ?? null,
    updatedOrder: results.at(-1)?.results?.[0] ?? null,
  };
}

/**
 * Aplica uma linha remota compacta em um deposito local correlacionado por qrId.
 *
 * @param {{ db: import("@cloudflare/workers-types").D1Database, tenantId: string, window: { start: string, end: string, status?: string }, remoteDeposit: ReturnType<typeof normalizeEulenDepositsListRow> }} input Dados da linha.
 * @returns {Promise<Record<string, unknown>>} Resultado serializavel da linha.
 */
async function reconcileDepositsListRow(input) {
  const deposit = await getDepositByQrId(input.db, input.tenantId, input.remoteDeposit.qrId);

  if (!deposit) {
    return {
      qrId: input.remoteDeposit.qrId,
      status: input.remoteDeposit.status,
      outcome: "skipped",
      reason: "local_deposit_not_found",
    };
  }

  const order = await getOrderById(input.db, input.tenantId, deposit.orderId);

  if (!order) {
    return {
      qrId: input.remoteDeposit.qrId,
      depositEntryId: deposit.depositEntryId,
      orderId: deposit.orderId,
      status: input.remoteDeposit.status,
      outcome: "failed",
      reason: "order_not_found",
    };
  }

  const mutationPlan = planDepositsListAggregateMutation(deposit, order, input.remoteDeposit);

  if (mutationPlan.skippedReason) {
    return {
      qrId: input.remoteDeposit.qrId,
      depositEntryId: deposit.depositEntryId,
      orderId: order.orderId,
      status: input.remoteDeposit.status,
      outcome: "skipped",
      reason: mutationPlan.skippedReason,
    };
  }

  const eventPayload = buildDepositsListEventPayload({
    window: input.window,
    remoteDeposit: input.remoteDeposit,
  });
  const incomingEvent = {
    externalStatus: input.remoteDeposit.status,
    rawPayload: eventPayload,
    bankTxId: input.remoteDeposit.bankTxId,
    blockchainTxId: input.remoteDeposit.blockchainTxId,
  };
  const eventInput = {
    tenantId: input.tenantId,
    orderId: order.orderId,
    depositEntryId: deposit.depositEntryId,
    qrId: input.remoteDeposit.qrId,
    source: DEPOSITS_LIST_SOURCE,
    externalStatus: input.remoteDeposit.status,
    bankTxId: input.remoteDeposit.bankTxId ?? null,
    blockchainTxId: input.remoteDeposit.blockchainTxId ?? null,
    requestId: input.requestId ?? null,
    rawPayload: eventPayload,
  };

  try {
    const { savedEvent, updatedDeposit, updatedOrder } = await persistDepositsListReconciliationAtomically(
      input.db,
      input.tenantId,
      eventInput,
      deposit,
      order,
      mutationPlan.depositPatch,
      mutationPlan.orderPatch,
    );

    if (!updatedDeposit || !updatedOrder) {
      throw new DepositsFallbackError(
        500,
        "deposits_fallback_persistence_incomplete",
        "Deposits fallback write completed without a readable aggregate snapshot.",
        {
          depositEntryId: deposit.depositEntryId,
          orderId: order.orderId,
          mayHaveCommitted: true,
          safeToRetry: true,
          source: DEPOSITS_LIST_SOURCE,
        },
      );
    }

    return {
      qrId: updatedDeposit.qrId ?? input.remoteDeposit.qrId,
      depositEntryId: updatedDeposit.depositEntryId,
      orderId: updatedOrder.orderId,
      status: input.remoteDeposit.status,
      eventId: savedEvent?.id,
      outcome: "processed",
      previousExternalStatus: deposit.externalStatus,
      previousOrderStatus: order.status,
      previousOrderCurrentStep: order.currentStep,
      orderStatus: updatedOrder.status,
      orderCurrentStep: updatedOrder.currentStep,
    };
  } catch (error) {
    if (!isLikelyUniqueConstraintError(error)) {
      throw error;
    }

    const savedEvents = await listDepositEventsByDepositEntryId(input.db, input.tenantId, deposit.depositEntryId);
    const duplicateEvent = findDuplicateDepositsListEvent(savedEvents, incomingEvent);

    if (!duplicateEvent) {
      throw error;
    }

    const currentDeposit = await getDepositByDepositEntryId(input.db, input.tenantId, deposit.depositEntryId);
    const currentOrder = await getOrderById(input.db, input.tenantId, order.orderId);

    if (!currentDeposit || !currentOrder) {
      throw error;
    }

    const repairPlan = planDepositsListAggregateMutation(currentDeposit, currentOrder, input.remoteDeposit);
    const shouldRepair = Object.keys(repairPlan.depositPatch).length > 0 || Object.keys(repairPlan.orderPatch).length > 0;
    const { updatedDeposit, updatedOrder } = shouldRepair
      ? await repairDepositsListAggregateAtomically(
        input.db,
        input.tenantId,
        currentDeposit,
        currentOrder,
        repairPlan.depositPatch,
        repairPlan.orderPatch,
      )
      : { updatedDeposit: currentDeposit, updatedOrder: currentOrder };

    return {
      qrId: updatedDeposit?.qrId ?? input.remoteDeposit.qrId,
      depositEntryId: updatedDeposit?.depositEntryId ?? deposit.depositEntryId,
      orderId: updatedOrder?.orderId ?? order.orderId,
      status: input.remoteDeposit.status,
      eventId: duplicateEvent.id,
      outcome: "duplicate",
      repairedAggregate: shouldRepair,
      previousExternalStatus: deposit.externalStatus,
      previousOrderStatus: order.status,
      previousOrderCurrentStep: order.currentStep,
      orderStatus: updatedOrder?.status ?? currentOrder.status,
      orderCurrentStep: updatedOrder?.currentStep ?? currentOrder.currentStep,
    };
  }
}

/**
 * Consulta `/deposits` e aplica reconciliacao por janela.
 *
 * @param {{ db: import("@cloudflare/workers-types").D1Database, runtimeConfig: { eulenApiBaseUrl: string, eulenApiTimeoutMs: number }, tenant: { tenantId: string, eulenPartnerId?: string }, eulenApiToken: string, rawBody: string, requestId?: string }} input Dependencias da rota.
 * @returns {Promise<{ ok: true, status: number, code: string, details: Record<string, unknown> }>} Resultado HTTP.
 */
export async function processDepositsFallback(input) {
  const body = parseDepositsFallbackBody(input.rawBody);
  const window = readDepositsFallbackWindow(body);
  let remoteDeposits;

  try {
    const response = await listEulenDeposits(input.runtimeConfig, {
      apiToken: input.eulenApiToken,
      partnerId: input.tenant.eulenPartnerId,
    }, {
      ...window,
      asyncMode: "false",
    });
    const resolvedResponse = await resolveEulenAsyncResponse(response);

    remoteDeposits = normalizeEulenDepositsListPayload(resolvedResponse.data);
  } catch (error) {
    if (error instanceof EulenApiError) {
      throw new DepositsFallbackError(
        502,
        "deposits_fallback_unavailable",
        "Could not read Eulen deposits for this window.",
        { window, cause: error.details },
        error,
      );
    }

    throw error;
  }

  const results = [];

  for (const remoteDeposit of remoteDeposits) {
    results.push(await reconcileDepositsListRow({
      db: input.db,
      tenantId: input.tenant.tenantId,
      window,
      remoteDeposit,
    }));
  }

  const summary = {
    remoteRows: remoteDeposits.length,
    processed: results.filter((result) => result.outcome === "processed").length,
    duplicate: results.filter((result) => result.outcome === "duplicate").length,
    skipped: results.filter((result) => result.outcome === "skipped").length,
    failed: results.filter((result) => result.outcome === "failed").length,
  };

  log(input.runtimeConfig, {
    level: summary.failed > 0 ? "warn" : "info",
    message: "ops.deposits_fallback.processed",
    tenantId: input.tenant.tenantId,
    requestId: input.requestId,
    details: {
      source: DEPOSITS_LIST_SOURCE,
      window,
      summary,
    },
  });

  return {
    ok: true,
    status: 200,
    code: "deposits_fallback_processed",
    details: {
      source: DEPOSITS_LIST_SOURCE,
      window,
      summary,
      results,
    },
  };
}
