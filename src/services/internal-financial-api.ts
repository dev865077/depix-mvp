import { readSecretBindingValue } from "../config/tenants.js";
import { log, type RuntimeLogConfig } from "../lib/logger.js";

import type { DepositRecord, OrderRecord } from "../types/persistence.js";
import type { TenantConfig, WorkerEnv } from "../types/runtime.js";

type FinancialRuntimeConfig = RuntimeLogConfig & {
  financialApiBaseUrl: string;
};

type RequestContext = {
  requestId?: string;
  method?: string;
  path?: string;
};

type TelegramPaymentBoundaryInput = {
  env: WorkerEnv;
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

type PaymentProjection = {
  ok: true;
  tenantId: string;
  orderId: string | null;
  correlationId: string | null;
  depositEntryId: string | null;
  qrId: string | null;
  qrCopyPaste: string | null;
  qrImageUrl: string | null;
  externalStatus: string | null;
  orderStatus: string | null;
  orderCurrentStep: string | null;
  expiration: string | null;
  duplicate: boolean;
  source?: string;
  requestId?: string;
};

type FinancialApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
};

type TelegramPaymentReconcileResult = {
  order: OrderRecord;
  deposit: DepositRecord;
  attempted: true;
  result: {
    code: string;
    details: {
      externalStatus: string | null;
      orderCurrentStep: string | null;
      orderStatus: string | null;
    };
  } | null;
  boundarySource: "external_financial_api";
  usedFallback: false;
};

type TelegramConfirmationSession = {
  order: OrderRecord;
  deposit: DepositRecord | null;
  accepted: boolean;
  conflict: boolean;
  parseResult: null;
  boundarySource: "external_financial_api";
  usedFallback: false;
};

const DEBOT_INTERNAL_API_TOKEN_BINDING = "DEBOT_INTERNAL_API_TOKEN";
const TELEGRAM_CONFIRMATION_FAILURE_MESSAGE = [
  "Não consegui criar seu Pix agora.",
  "Seu pedido foi encerrado com falha para evitar duplicidade silenciosa.",
  "Envie /start para recomecar com segurança.",
].join("\n\n");

export class FinancialApiBoundaryError extends Error {
  code: string;
  status: number;
  userMessage: string;
  details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: Readonly<{
      status?: number;
      userMessage?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    }> = {},
  ) {
    super(message, {
      cause: options.cause,
    });

    this.name = "FinancialApiBoundaryError";
    this.code = code;
    this.status = options.status ?? 502;
    this.userMessage = options.userMessage ?? TELEGRAM_CONFIRMATION_FAILURE_MESSAGE;
    this.details = options.details ?? {};
  }
}

function buildFinancialApiUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/u, "");

  if (normalizedBaseUrl.length === 0) {
    throw new FinancialApiBoundaryError(
      "financial_api_base_url_missing",
      "Financial API base URL is not configured.",
      { status: 500 },
    );
  }

  return `${normalizedBaseUrl}${path}`;
}

async function readFinancialApiToken(env: WorkerEnv): Promise<string> {
  return readSecretBindingValue(env, DEBOT_INTERNAL_API_TOKEN_BINDING);
}

function buildProjectionOrder(projection: PaymentProjection, fallbackOrder: OrderRecord): OrderRecord {
  return {
    ...fallbackOrder,
    tenantId: projection.tenantId || fallbackOrder.tenantId,
    orderId: projection.orderId ?? fallbackOrder.orderId,
    correlationId: projection.correlationId ?? fallbackOrder.correlationId,
    currentStep: projection.orderCurrentStep ?? fallbackOrder.currentStep,
    status: projection.orderStatus ?? fallbackOrder.status,
  } as OrderRecord;
}

function buildProjectionDeposit(
  projection: PaymentProjection,
  order: OrderRecord,
  fallbackDeposit?: DepositRecord | null,
): DepositRecord | null {
  const depositEntryId = projection.depositEntryId ?? fallbackDeposit?.depositEntryId ?? null;

  if (!depositEntryId) {
    return null;
  }

  return {
    tenantId: projection.tenantId || fallbackDeposit?.tenantId || order.tenantId,
    depositEntryId,
    qrId: projection.qrId ?? fallbackDeposit?.qrId ?? null,
    orderId: projection.orderId ?? fallbackDeposit?.orderId ?? order.orderId,
    nonce: fallbackDeposit?.nonce ?? "external_financial_api",
    createdRequestId: fallbackDeposit?.createdRequestId ?? projection.requestId ?? null,
    qrCopyPaste: projection.qrCopyPaste ?? fallbackDeposit?.qrCopyPaste ?? "",
    qrImageUrl: projection.qrImageUrl ?? fallbackDeposit?.qrImageUrl ?? "",
    externalStatus: projection.externalStatus ?? fallbackDeposit?.externalStatus ?? "",
    expiration: projection.expiration ?? fallbackDeposit?.expiration ?? null,
    createdAt: fallbackDeposit?.createdAt ?? "",
    updatedAt: fallbackDeposit?.updatedAt ?? "",
  } as DepositRecord;
}

async function readErrorBody(response: Response): Promise<FinancialApiErrorBody> {
  try {
    return await response.json() as FinancialApiErrorBody;
  } catch {
    return {};
  }
}

async function requestPaymentProjection(
  input: TelegramPaymentBoundaryInput,
  request: Readonly<{
    method: "POST" | "GET";
    path: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    correlationId?: string;
  }>,
): Promise<PaymentProjection> {
  const token = await readFinancialApiToken(input.env);
  const response = await fetch(buildFinancialApiUrl(input.runtimeConfig.financialApiBaseUrl, request.path), {
    method: request.method,
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
      ...(request.body ? { "Content-Type": "application/json" } : {}),
      ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}),
      ...(request.correlationId ? { "X-Correlation-Id": request.correlationId } : {}),
      ...(input.requestContext?.requestId ? { "X-Request-Id": input.requestContext.requestId } : {}),
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await readErrorBody(response);
    const code = errorBody.error?.code ?? "financial_api_request_failed";

    throw new FinancialApiBoundaryError(
      code,
      errorBody.error?.message ?? `Financial API request failed with status ${response.status}.`,
      {
        status: response.status,
        details: errorBody.error?.details ?? {
          path: request.path,
          status: response.status,
        },
      },
    );
  }

  const projection = await response.json() as PaymentProjection;

  if (projection?.ok !== true) {
    throw new FinancialApiBoundaryError(
      "financial_api_projection_invalid",
      "Financial API returned an invalid payment projection.",
      {
        status: 502,
        details: {
          path: request.path,
        },
      },
    );
  }

  return projection;
}

function logBoundarySuccess(
  runtimeConfig: FinancialRuntimeConfig,
  tenantId: string,
  requestId: string | undefined,
  operation: "confirm" | "reconcile",
  projection: PaymentProjection,
): void {
  log(runtimeConfig, {
    level: "info",
    message: `telegram.payment_boundary.${operation}_external_api_completed`,
    tenantId,
    requestId,
    details: {
      orderId: projection.orderId,
      depositEntryId: projection.depositEntryId,
      source: projection.source,
    },
  });
}

export async function confirmTelegramPaymentWithBoundary(
  input: TelegramPaymentConfirmationInput,
): Promise<TelegramConfirmationSession> {
  const projection = await requestPaymentProjection(input, {
    method: "POST",
    path: `/financial-api/v1/tenants/${encodeURIComponent(input.tenant.tenantId)}/payments`,
    idempotencyKey: `telegram:${input.tenant.tenantId}:${input.order.orderId}`,
    correlationId: input.order.correlationId,
    body: {
      orderId: input.order.orderId,
      correlationId: input.order.correlationId,
      amountInCents: input.order.amountInCents,
      walletAddress: input.order.walletAddress,
      channel: input.order.channel,
      resumeIfExists: true,
    },
  });
  const order = buildProjectionOrder(projection, input.order);
  const deposit = buildProjectionDeposit(projection, order);

  logBoundarySuccess(
    input.runtimeConfig,
    input.tenant.tenantId,
    input.requestContext?.requestId,
    "confirm",
    projection,
  );

  return {
    order,
    deposit,
    accepted: !projection.duplicate,
    conflict: projection.duplicate,
    parseResult: null,
    boundarySource: "external_financial_api",
    usedFallback: false,
  };
}

export async function reconcileTelegramPaymentWithBoundary(
  input: TelegramPaymentReconcileInput,
): Promise<TelegramPaymentReconcileResult> {
  const projection = await requestPaymentProjection(input, {
    method: "POST",
    path: `/financial-api/v1/tenants/${encodeURIComponent(input.tenant.tenantId)}/payments/${encodeURIComponent(input.deposit.depositEntryId)}/reconcile`,
    correlationId: input.order.correlationId,
    body: {
      orderId: input.order.orderId,
      reason: "status_poll",
    },
  });
  const order = buildProjectionOrder(projection, input.order);
  const deposit = buildProjectionDeposit(projection, order, input.deposit);

  if (!deposit) {
    throw new FinancialApiBoundaryError(
      "financial_api_projection_missing_deposit",
      "Financial API reconcile response did not include a deposit projection.",
      {
        status: 502,
        details: {
          orderId: input.order.orderId,
          depositEntryId: input.deposit.depositEntryId,
        },
      },
    );
  }

  logBoundarySuccess(
    input.runtimeConfig,
    input.tenant.tenantId,
    input.requestContext?.requestId,
    "reconcile",
    projection,
  );

  return {
    order,
    deposit,
    attempted: true,
    result: {
      code: "financial_api_reconcile_completed",
      details: {
        externalStatus: projection.externalStatus,
        orderCurrentStep: projection.orderCurrentStep,
        orderStatus: projection.orderStatus,
      },
    },
    boundarySource: "external_financial_api",
    usedFallback: false,
  };
}
