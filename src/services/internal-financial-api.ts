import { readTenantSecret } from "../config/tenants.js";
import { getLatestDepositByOrderId } from "../db/repositories/deposits-repository.js";
import { getOrderById } from "../db/repositories/orders-repository.js";
import { log, type RuntimeLogConfig } from "../lib/logger.js";
import {
  confirmTelegramOrder,
  TelegramOrderConfirmationError,
} from "./telegram-order-confirmation.js";
import { processDepositRecheck } from "./eulen-deposit-recheck.js";

import type { DepositRecord, OrderRecord } from "../types/persistence.js";
import type { TenantConfig, WorkerEnv } from "../types/runtime.js";
import type { EulenRuntimeConfig } from "../clients/eulen-client.js";

type FinancialRuntimeConfig = EulenRuntimeConfig & RuntimeLogConfig;

type RequestContext = {
  requestId?: string;
  method?: string;
  path?: string;
};

type TelegramPaymentBoundaryInput = {
  env: WorkerEnv;
  db: D1Database;
  tenant: TenantConfig;
  runtimeConfig: FinancialRuntimeConfig;
  requestContext?: RequestContext;
};

type TelegramPaymentConfirmationInput = TelegramPaymentBoundaryInput & {
  order: OrderRecord;
};

type TelegramPaymentReconcileInput = TelegramPaymentBoundaryInput & {
  order: OrderRecord;
  deposit: DepositRecord;
};

type TelegramPaymentReconcileResult = {
  order: OrderRecord;
  deposit: DepositRecord;
  attempted: true;
  result: Awaited<ReturnType<typeof processDepositRecheck>> | null;
  boundarySource: "internal_financial_api" | "legacy_recheck_path";
  usedFallback: boolean;
};

type BoundaryDependencies = {
  confirmThroughBoundary: (input: TelegramPaymentConfirmationInput) => ReturnType<typeof confirmTelegramOrder>;
  confirmLegacyFallback: (input: TelegramPaymentConfirmationInput) => ReturnType<typeof confirmTelegramOrder>;
  reconcileThroughBoundary: (input: TelegramPaymentReconcileInput) => Promise<TelegramPaymentReconcileResult>;
  reconcileLegacyFallback: (input: TelegramPaymentReconcileInput) => Promise<TelegramPaymentReconcileResult>;
};

type TelegramConfirmationSession = Awaited<ReturnType<typeof confirmTelegramOrder>> & {
  boundarySource: "internal_financial_api" | "legacy_confirmation_path";
  usedFallback: boolean;
};

async function confirmTelegramPaymentThroughBoundary(
  input: TelegramPaymentConfirmationInput,
): Promise<Awaited<ReturnType<typeof confirmTelegramOrder>>> {
  return confirmTelegramOrder(input);
}

async function reconcileTelegramPaymentThroughBoundary(
  input: TelegramPaymentReconcileInput,
): Promise<TelegramPaymentReconcileResult> {
  const eulenApiToken = await readTenantSecret(input.env, input.tenant, "eulenApiToken");
  const result = await processDepositRecheck({
    db: input.db,
    runtimeConfig: input.runtimeConfig,
    tenant: input.tenant,
    eulenApiToken,
    rawBody: JSON.stringify({
      depositEntryId: input.deposit.depositEntryId,
    }),
    requestId: input.requestContext?.requestId,
  });
  const [updatedOrder, updatedDeposit] = await Promise.all([
    getOrderById(input.db, input.tenant.tenantId, String(input.order.orderId)),
    getLatestDepositByOrderId(input.db, input.tenant.tenantId, String(input.order.orderId)),
  ]);

  return {
    order: (updatedOrder ?? input.order) as OrderRecord,
    deposit: (updatedDeposit ?? input.deposit) as DepositRecord,
    attempted: true,
    result,
    boundarySource: "internal_financial_api",
    usedFallback: false,
  };
}

async function reconcileTelegramPaymentThroughLegacyFallback(
  input: TelegramPaymentReconcileInput,
): Promise<TelegramPaymentReconcileResult> {
  const eulenApiToken = await readTenantSecret(input.env, input.tenant, "eulenApiToken");
  const result = await processDepositRecheck({
    db: input.db,
    runtimeConfig: input.runtimeConfig,
    tenant: input.tenant,
    eulenApiToken,
    rawBody: JSON.stringify({
      depositEntryId: input.deposit.depositEntryId,
    }),
    requestId: input.requestContext?.requestId,
  });
  const [updatedOrder, updatedDeposit] = await Promise.all([
    getOrderById(input.db, input.tenant.tenantId, String(input.order.orderId)),
    getLatestDepositByOrderId(input.db, input.tenant.tenantId, String(input.order.orderId)),
  ]);

  return {
    order: (updatedOrder ?? input.order) as OrderRecord,
    deposit: (updatedDeposit ?? input.deposit) as DepositRecord,
    attempted: true,
    result,
    boundarySource: "legacy_recheck_path",
    usedFallback: true,
  };
}

const DEFAULT_BOUNDARY_DEPENDENCIES: BoundaryDependencies = {
  confirmThroughBoundary: confirmTelegramPaymentThroughBoundary,
  confirmLegacyFallback: confirmTelegramOrder,
  reconcileThroughBoundary: reconcileTelegramPaymentThroughBoundary,
  reconcileLegacyFallback: reconcileTelegramPaymentThroughLegacyFallback,
};

function logBoundaryFallback(
  runtimeConfig: FinancialRuntimeConfig,
  tenantId: string,
  requestId: string | undefined,
  operation: "confirm" | "reconcile",
  error: unknown,
): void {
  log(runtimeConfig, {
    level: "warn",
    message: `telegram.payment_boundary.${operation}_fallback`,
    tenantId,
    requestId,
    details: {
      cause: error instanceof Error ? error.message : String(error),
    },
  });
}

export async function confirmTelegramPaymentWithBoundary(
  input: TelegramPaymentConfirmationInput,
  dependencies: BoundaryDependencies = DEFAULT_BOUNDARY_DEPENDENCIES,
): Promise<TelegramConfirmationSession> {
  try {
    const session = await dependencies.confirmThroughBoundary(input);

    return {
      ...session,
      boundarySource: "internal_financial_api",
      usedFallback: false,
    };
  } catch (error) {
    if (error instanceof TelegramOrderConfirmationError) {
      throw error;
    }

    logBoundaryFallback(
      input.runtimeConfig,
      input.tenant.tenantId,
      input.requestContext?.requestId,
      "confirm",
      error,
    );

    const session = await dependencies.confirmLegacyFallback(input);

    return {
      ...session,
      boundarySource: "legacy_confirmation_path",
      usedFallback: true,
    };
  }
}

export async function reconcileTelegramPaymentWithBoundary(
  input: TelegramPaymentReconcileInput,
  dependencies: BoundaryDependencies = DEFAULT_BOUNDARY_DEPENDENCIES,
): Promise<TelegramPaymentReconcileResult> {
  try {
    return await dependencies.reconcileThroughBoundary(input);
  } catch (error) {
    logBoundaryFallback(
      input.runtimeConfig,
      input.tenant.tenantId,
      input.requestContext?.requestId,
      "reconcile",
      error,
    );

    return dependencies.reconcileLegacyFallback(input);
  }
}
