/**
 * Reconciliacao agendada bounded para depositos Telegram pendentes.
 *
 * O cron nao cria uma nova rota operacional. Ele apenas orquestra, por tenant,
 * a chamada direta ao service idempotente de `deposit-status`.
 */
import { readTenantSecret } from "../config/tenants.js";
import {
  claimPendingTelegramDepositForScheduledReconciliation,
  listPendingTelegramDepositsForScheduledReconciliation,
  releaseScheduledDepositReconciliationClaim,
} from "../db/repositories/deposits-repository.js";
import { log } from "../lib/logger.js";
import { processDepositRecheck } from "./eulen-deposit-recheck.js";
import { notifyTelegramOrderTransitionSafely } from "./telegram-payment-notifications.js";

export const SCHEDULED_DEPOSIT_RECONCILIATION_PER_TENANT_LIMIT = 5;
export const SCHEDULED_DEPOSIT_RECONCILIATION_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SCHEDULED_DEPOSIT_RECONCILIATION_CLAIM_STALE_MS = 10 * 60 * 1000;

function toIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);

  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function buildWindowStartIso(scheduledTime) {
  return new Date(
    new Date(toIsoDate(scheduledTime)).getTime() - SCHEDULED_DEPOSIT_RECONCILIATION_WINDOW_MS,
  ).toISOString();
}

function buildClaimStaleBeforeIso(scheduledTime) {
  return new Date(
    new Date(toIsoDate(scheduledTime)).getTime() - SCHEDULED_DEPOSIT_RECONCILIATION_CLAIM_STALE_MS,
  ).toISOString();
}

function summarizeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : error?.name ?? "scheduled_deposit_reconciliation_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function buildRequestId(input) {
  if (input.requestId) {
    return input.requestId;
  }

  const scheduledTime = toIsoDate(input.scheduledTime);
  const cron = input.cron ?? "manual";

  return `scheduled-deposit-reconciliation:${cron}:${scheduledTime}`;
}

function createEmptyTenantSummary(tenantId) {
  return {
    tenantId,
    selected: 0,
    processed: 0,
    duplicates: 0,
    claimSkipped: 0,
    failed: 0,
    notificationDelivered: 0,
    notificationSkipped: 0,
    notificationFailed: 0,
  };
}

function combineTenantSummaries(tenantSummaries) {
  return tenantSummaries.reduce((summary, tenantSummary) => ({
    tenants: summary.tenants + 1,
    selected: summary.selected + tenantSummary.selected,
    processed: summary.processed + tenantSummary.processed,
    duplicates: summary.duplicates + tenantSummary.duplicates,
    claimSkipped: summary.claimSkipped + tenantSummary.claimSkipped,
    failed: summary.failed + tenantSummary.failed,
    notificationDelivered: summary.notificationDelivered + tenantSummary.notificationDelivered,
    notificationSkipped: summary.notificationSkipped + tenantSummary.notificationSkipped,
    notificationFailed: summary.notificationFailed + tenantSummary.notificationFailed,
  }), {
    tenants: 0,
    selected: 0,
    processed: 0,
    duplicates: 0,
    claimSkipped: 0,
    failed: 0,
    notificationDelivered: 0,
    notificationSkipped: 0,
    notificationFailed: 0,
  });
}

async function notifyAfterScheduledRecheck(input, result) {
  const notificationResult = await notifyTelegramOrderTransitionSafely({
    env: input.env,
    db: input.db,
    runtimeConfig: input.runtimeConfig,
    tenant: input.tenant,
    requestContext: {
      requestId: input.requestId,
      method: "SCHEDULED",
      path: "scheduled://deposit-reconciliation",
    },
    ...result.details,
  });

  if (notificationResult.delivered) {
    return "delivered";
  }

  if (notificationResult.failed) {
    return "failed";
  }

  return "skipped";
}

async function reconcileScheduledDeposit(input) {
  const result = await processDepositRecheck({
    db: input.db,
    runtimeConfig: input.runtimeConfig,
    tenant: input.tenant,
    eulenApiToken: input.eulenApiToken,
    rawBody: JSON.stringify({
      depositEntryId: input.deposit.depositEntryId,
    }),
    requestId: input.requestId,
  });
  const notificationState = await notifyAfterScheduledRecheck(input, result);

  log(input.runtimeConfig, {
    level: "info",
    message: "ops.scheduled_deposit_reconciliation.deposit_processed",
    tenantId: input.tenant.tenantId,
    requestId: input.requestId,
    details: {
      depositEntryId: input.deposit.depositEntryId,
      orderId: input.deposit.orderId,
      code: result.code,
      duplicate: Boolean(result.details.duplicate),
      externalStatus: result.details.externalStatus ?? null,
      notificationState,
    },
  });

  return {
    result,
    notificationState,
  };
}

async function claimScheduledDeposit(input) {
  return claimPendingTelegramDepositForScheduledReconciliation(
    input.db,
    input.tenant.tenantId,
    input.deposit.depositEntryId,
    input.deposit.externalStatus,
    input.deposit.updatedAt,
    new Date().toISOString(),
    input.claimStaleBeforeIso,
  );
}

async function releaseScheduledDepositClaim(input) {
  try {
    await releaseScheduledDepositReconciliationClaim(
      input.db,
      input.tenant.tenantId,
      input.deposit.depositEntryId,
    );
  } catch (error) {
    const summarizedError = summarizeError(error);

    log(input.runtimeConfig, {
      level: "error",
      message: "ops.scheduled_deposit_reconciliation.claim_release_failed",
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      details: {
        depositEntryId: input.deposit.depositEntryId,
        orderId: input.deposit.orderId,
        code: summarizedError.code,
        cause: summarizedError.message,
      },
    });
  }
}

async function reconcileScheduledTenant(input) {
  const tenantSummary = createEmptyTenantSummary(input.tenant.tenantId);
  let eulenApiToken;

  try {
    eulenApiToken = await readTenantSecret(input.env, input.tenant, "eulenApiToken");
  } catch (error) {
    tenantSummary.failed += 1;
    const summarizedError = summarizeError(error);

    log(input.runtimeConfig, {
      level: "error",
      message: "ops.scheduled_deposit_reconciliation.tenant_failed",
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      details: {
        code: summarizedError.code,
        cause: summarizedError.message,
      },
    });

    return tenantSummary;
  }

  let deposits;

  try {
    deposits = await listPendingTelegramDepositsForScheduledReconciliation(
      input.db,
      input.tenant.tenantId,
      input.windowStartIso,
      SCHEDULED_DEPOSIT_RECONCILIATION_PER_TENANT_LIMIT,
      input.claimStaleBeforeIso,
    );
  } catch (error) {
    tenantSummary.failed += 1;
    const summarizedError = summarizeError(error);

    log(input.runtimeConfig, {
      level: "error",
      message: "ops.scheduled_deposit_reconciliation.tenant_failed",
      tenantId: input.tenant.tenantId,
      requestId: input.requestId,
      details: {
        code: summarizedError.code,
        cause: summarizedError.message,
      },
    });

    return tenantSummary;
  }

  tenantSummary.selected = deposits.length;

  for (const deposit of deposits) {
    let claimed = false;

    try {
      claimed = await claimScheduledDeposit({
        ...input,
        deposit,
      });

      if (!claimed) {
        tenantSummary.claimSkipped += 1;

        log(input.runtimeConfig, {
          level: "info",
          message: "ops.scheduled_deposit_reconciliation.deposit_skipped",
          tenantId: input.tenant.tenantId,
          requestId: input.requestId,
          details: {
            depositEntryId: deposit.depositEntryId,
            orderId: deposit.orderId,
            reason: "claim_not_acquired",
          },
        });

        continue;
      }

      const { result, notificationState } = await reconcileScheduledDeposit({
        ...input,
        eulenApiToken,
        deposit,
      });

      tenantSummary.processed += 1;

      if (result.code === "deposit_recheck_duplicate") {
        tenantSummary.duplicates += 1;
      }

      if (notificationState === "delivered") {
        tenantSummary.notificationDelivered += 1;
      } else if (notificationState === "failed") {
        tenantSummary.notificationFailed += 1;
      } else {
        tenantSummary.notificationSkipped += 1;
      }
    } catch (error) {
      tenantSummary.failed += 1;
      const summarizedError = summarizeError(error);

      log(input.runtimeConfig, {
        level: "error",
        message: "ops.scheduled_deposit_reconciliation.deposit_failed",
        tenantId: input.tenant.tenantId,
        requestId: input.requestId,
        details: {
          depositEntryId: deposit.depositEntryId,
          orderId: deposit.orderId,
          code: summarizedError.code,
          cause: summarizedError.message,
        },
      });
    } finally {
      if (claimed) {
        await releaseScheduledDepositClaim({
          ...input,
          deposit,
        });
      }
    }
  }

  log(input.runtimeConfig, {
    level: "info",
    message: "ops.scheduled_deposit_reconciliation.tenant_summary",
    tenantId: input.tenant.tenantId,
    requestId: input.requestId,
    details: tenantSummary,
  });

  return tenantSummary;
}

/**
 * Executa a reconciliacao agendada bounded.
 *
 * @param {{
 *   env: Record<string, unknown>,
 *   db?: import("@cloudflare/workers-types").D1Database,
 *   runtimeConfig: ReturnType<import("../config/runtime.js").readRuntimeConfig>,
 *   scheduledTime?: string | number | Date,
 *   cron?: string,
 *   requestId?: string
 * }} input Dependencias do scheduled handler.
 * @returns {Promise<Record<string, unknown>>} Sumario operacional redigido.
 */
export async function runScheduledDepositReconciliation(input) {
  const requestId = buildRequestId(input);
  const scheduledTime = toIsoDate(input.scheduledTime ?? new Date());
  const windowStartIso = buildWindowStartIso(scheduledTime);
  const claimStaleBeforeIso = buildClaimStaleBeforeIso(scheduledTime);
  const operation = input.runtimeConfig.operations.scheduledDepositReconciliation;

  if (!operation.ready) {
    log(input.runtimeConfig, {
      level: "info",
      message: "ops.scheduled_deposit_reconciliation.skipped",
      requestId,
      details: {
        state: operation.state,
        enabled: operation.enabled,
        cron: input.cron ?? null,
        scheduledTime,
      },
    });

    return {
      ok: true,
      skipped: true,
      state: operation.state,
      requestId,
    };
  }

  if (!input.db) {
    log(input.runtimeConfig, {
      level: "error",
      message: "ops.scheduled_deposit_reconciliation.skipped",
      requestId,
      details: {
        state: "missing_database",
        enabled: operation.enabled,
        cron: input.cron ?? null,
        scheduledTime,
      },
    });

    return {
      ok: false,
      skipped: true,
      state: "missing_database",
      requestId,
    };
  }

  log(input.runtimeConfig, {
    level: "info",
    message: "ops.scheduled_deposit_reconciliation.started",
    requestId,
    details: {
      cron: input.cron ?? null,
      scheduledTime,
      windowStartIso,
      claimStaleBeforeIso,
      perTenantLimit: SCHEDULED_DEPOSIT_RECONCILIATION_PER_TENANT_LIMIT,
    },
  });

  const tenantSummaries = [];

  for (const tenant of Object.values(input.runtimeConfig.tenants)) {
    tenantSummaries.push(await reconcileScheduledTenant({
      env: input.env,
      db: input.db,
      runtimeConfig: input.runtimeConfig,
      tenant,
      requestId,
      windowStartIso,
      claimStaleBeforeIso,
    }));
  }

  const summary = combineTenantSummaries(tenantSummaries);

  log(input.runtimeConfig, {
    level: "info",
    message: "ops.scheduled_deposit_reconciliation.summary",
    requestId,
    details: {
      ...summary,
      cron: input.cron ?? null,
      scheduledTime,
      windowStartIso,
      claimStaleBeforeIso,
    },
  });

  return {
    ok: true,
    skipped: false,
    requestId,
    windowStartIso,
    claimStaleBeforeIso,
    ...summary,
  };
}
