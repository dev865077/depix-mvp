/**
 * Maquina de progressao inicial de pedidos.
 *
 * Este modulo e deliberadamente puro: ele nao conhece Telegram, Hono,
 * Cloudflare Workers, D1, Eulen ou qualquer binding externo. A borda da
 * aplicacao entrega apenas contexto de negocio e eventos de dominio; a maquina
 * devolve o proximo estado e um patch seguro para persistencia.
 *
 * Essa separacao e importante no Worker da Cloudflare porque o isolate pode ser
 * reutilizado entre requests. O estado conversacional real deve ficar no D1, e
 * nao em memoria global do runtime.
 */
import { assign, createMachine, getInitialSnapshot, getNextSnapshot } from "xstate";

import type { DepositEntryId, OrderId, OrderStatus, OrderStep, TenantId } from "../types/domain.js";
import {
  ORDER_PROGRESS_EVENTS as RAW_ORDER_PROGRESS_EVENTS,
  ORDER_PROGRESS_LEGACY_STEP_ALIASES as RAW_ORDER_PROGRESS_LEGACY_STEP_ALIASES,
  ORDER_PROGRESS_STATES as RAW_ORDER_PROGRESS_STATES,
  ORDER_PROGRESS_TERMINAL_LOOKUP_STEPS as RAW_ORDER_PROGRESS_TERMINAL_LOOKUP_STEPS,
  ORDER_PROGRESS_TERMINAL_STATES as RAW_ORDER_PROGRESS_TERMINAL_STATES,
  ORDER_STATUS_BY_STEP as RAW_ORDER_STATUS_BY_STEP,
  isTerminalOrderProgressStep as rawIsTerminalOrderProgressStep,
  normalizePersistedOrderProgressStep as rawNormalizePersistedOrderProgressStep,
} from "./order-progress-constants.js";

type OrderProgressStateRecord = Readonly<{
  DRAFT: "draft";
  AMOUNT: "amount";
  WALLET: "wallet";
  CONFIRMATION: "confirmation";
  CREATING_DEPOSIT: "creating_deposit";
  AWAITING_PAYMENT: "awaiting_payment";
  COMPLETED: "completed";
  FAILED: "failed";
  CANCELED: "canceled";
  MANUAL_REVIEW: "manual_review";
}>;

type OrderProgressEventRecord = Readonly<{
  START_ORDER: "START_ORDER";
  AMOUNT_RECEIVED: "AMOUNT_RECEIVED";
  WALLET_RECEIVED: "WALLET_RECEIVED";
  CUSTOMER_CONFIRMED: "CUSTOMER_CONFIRMED";
  DEPOSIT_CREATED: "DEPOSIT_CREATED";
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED";
  FAIL_ORDER: "FAIL_ORDER";
  CANCEL_ORDER: "CANCEL_ORDER";
}>;

export const ORDER_PROGRESS_STATES = RAW_ORDER_PROGRESS_STATES as OrderProgressStateRecord;
export const ORDER_PROGRESS_EVENTS = RAW_ORDER_PROGRESS_EVENTS as OrderProgressEventRecord;
export const ORDER_PROGRESS_LEGACY_STEP_ALIASES = RAW_ORDER_PROGRESS_LEGACY_STEP_ALIASES as Readonly<Record<string, OrderProgressState>>;
export const ORDER_STATUS_BY_STEP = RAW_ORDER_STATUS_BY_STEP as Readonly<Record<OrderProgressState, OrderStatus>>;
export const ORDER_PROGRESS_TERMINAL_STATES = RAW_ORDER_PROGRESS_TERMINAL_STATES as readonly OrderProgressState[];
export const ORDER_PROGRESS_TERMINAL_LOOKUP_STEPS = RAW_ORDER_PROGRESS_TERMINAL_LOOKUP_STEPS as readonly string[];

export type OrderProgressState = typeof ORDER_PROGRESS_STATES[keyof typeof ORDER_PROGRESS_STATES];
export type OrderProgressEventType = typeof ORDER_PROGRESS_EVENTS[keyof typeof ORDER_PROGRESS_EVENTS];
export type OrderProgressLegacyStepAlias = keyof typeof ORDER_PROGRESS_LEGACY_STEP_ALIASES;
export type PersistedOrderProgressStep = OrderProgressState | OrderProgressLegacyStepAlias;

export type OrderProgressContext = {
  tenantId: TenantId | null;
  orderId: OrderId | null;
  userId: string | null;
  amountInCents: number | null;
  walletAddress: string | null;
  depositEntryId: DepositEntryId | null;
  qrId: string | null;
  failureReason: string | null;
};

type OrderProgressContextInput = Partial<{
  tenantId: string | null;
  orderId: string | null;
  userId: string | null;
  amountInCents: number | null;
  walletAddress: string | null;
  depositEntryId: string | null;
  qrId: string | null;
  failureReason: string | null;
}>;

type TenantScopedEvent = {
  tenantId?: string | null;
};

type StartOrderEvent = TenantScopedEvent & {
  type: typeof ORDER_PROGRESS_EVENTS.START_ORDER;
};

type AmountReceivedEvent = TenantScopedEvent & {
  type: typeof ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED;
  amountInCents: number;
};

type WalletReceivedEvent = TenantScopedEvent & {
  type: typeof ORDER_PROGRESS_EVENTS.WALLET_RECEIVED;
  walletAddress: string;
};

type CustomerConfirmedEvent = TenantScopedEvent & {
  type: typeof ORDER_PROGRESS_EVENTS.CUSTOMER_CONFIRMED;
};

type DepositCreatedEvent = TenantScopedEvent & {
  type: typeof ORDER_PROGRESS_EVENTS.DEPOSIT_CREATED;
  depositEntryId: string;
  qrId?: string | null;
};

type PaymentConfirmedEvent = TenantScopedEvent & {
  type: typeof ORDER_PROGRESS_EVENTS.PAYMENT_CONFIRMED;
};

type FailOrderEvent = TenantScopedEvent & {
  type: typeof ORDER_PROGRESS_EVENTS.FAIL_ORDER;
  reason?: string | null;
};

type CancelOrderEvent = TenantScopedEvent & {
  type: typeof ORDER_PROGRESS_EVENTS.CANCEL_ORDER;
};

export type OrderProgressEvent =
  | StartOrderEvent
  | AmountReceivedEvent
  | WalletReceivedEvent
  | CustomerConfirmedEvent
  | DepositCreatedEvent
  | PaymentConfirmedEvent
  | FailOrderEvent
  | CancelOrderEvent;

type UnknownOrderProgressEvent = TenantScopedEvent & {
  type?: string | null;
  amountInCents?: unknown;
  walletAddress?: unknown;
  depositEntryId?: unknown;
  qrId?: unknown;
  reason?: unknown;
};

export type OrderProgressionPatch = {
  currentStep: OrderStep;
  status: OrderStatus;
  amountInCents?: number;
  walletAddress?: string;
};

export type OrderProgressionResult = {
  currentStep: OrderStep;
  previousStep: string | null;
  status: OrderStatus;
  context: OrderProgressContext;
  persistenceGuard: {
    tenantId: TenantId | null;
    orderId: OrderId | null;
    expectedCurrentStep: string | null;
  };
  orderPatch: OrderProgressionPatch;
};

const KNOWN_STATES = new Set<OrderProgressState>(Object.values(ORDER_PROGRESS_STATES));
const KNOWN_EVENTS = new Set<OrderProgressEventType>(Object.values(ORDER_PROGRESS_EVENTS));

export function normalizePersistedOrderProgressStep(currentStep: unknown): unknown {
  return rawNormalizePersistedOrderProgressStep(currentStep);
}

export function isTerminalOrderProgressStep(currentStep: unknown): boolean {
  return rawIsTerminalOrderProgressStep(currentStep);
}

/**
 * Erro de dominio usado pela camada de aplicacao para distinguir falha de
 * transicao de erro inesperado de runtime.
 */
export class OrderProgressionError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OrderProgressionError";
    this.code = code;
    this.details = details;
  }
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptionalText(value: unknown): string | null {
  return hasText(value) ? value.trim() : null;
}

function normalizeOrderContext(input: OrderProgressContextInput = {}): OrderProgressContext {
  const amountInCents =
    typeof input.amountInCents === "number" && Number.isSafeInteger(input.amountInCents) ? input.amountInCents : null;

  return {
    tenantId: normalizeOptionalText(input.tenantId),
    orderId: normalizeOptionalText(input.orderId),
    userId: normalizeOptionalText(input.userId),
    amountInCents,
    walletAddress: normalizeOptionalText(input.walletAddress),
    depositEntryId: normalizeOptionalText(input.depositEntryId) as DepositEntryId | null,
    qrId: normalizeOptionalText(input.qrId),
    failureReason: normalizeOptionalText(input.failureReason),
  };
}

function requireOrderBoundaryContext(
  context: OrderProgressContext,
  event?: TenantScopedEvent,
): asserts context is OrderProgressContext & { tenantId: TenantId; orderId: OrderId } {
  if (!hasText(context.tenantId)) {
    throw new OrderProgressionError("missing_tenant_context", "Order progression requires a tenantId.");
  }

  if (!hasText(context.orderId)) {
    throw new OrderProgressionError("missing_order_context", "Order progression requires an orderId.");
  }

  if (hasText(event?.tenantId) && event.tenantId !== context.tenantId) {
    throw new OrderProgressionError("tenant_mismatch", "Order progression event tenantId does not match context.", {
      contextTenantId: context.tenantId,
      eventTenantId: event.tenantId,
    });
  }
}

function requireKnownState(currentStep: unknown): OrderProgressState {
  const normalizedStep = normalizePersistedOrderProgressStep(currentStep);

  if (typeof normalizedStep !== "string" || !KNOWN_STATES.has(normalizedStep as OrderProgressState)) {
    throw new OrderProgressionError("unknown_order_step", `Unknown order step: ${String(currentStep)}.`, { currentStep });
  }

  return normalizedStep as OrderProgressState;
}

function requireKnownEvent(event: UnknownOrderProgressEvent | null | undefined): OrderProgressEvent {
  if (!event || !hasText(event.type) || !KNOWN_EVENTS.has(event.type as OrderProgressEventType)) {
    throw new OrderProgressionError("unknown_order_event", `Unknown order event: ${event?.type ?? "missing"}.`, {
      eventType: event?.type,
    });
  }

  return event as OrderProgressEvent;
}

/**
 * Maquina XState do primeiro caminho feliz do pedido.
 *
 * Estados persistem em `orders.current_step`; status derivados persistem em
 * `orders.status`. A maquina so calcula transicoes validas, enquanto services
 * separados continuam responsaveis por side effects como criar deposito na
 * Eulen ou gravar no D1.
 */
export const orderProgressMachine = createMachine({
  types: {} as {
    context: OrderProgressContext;
    events: OrderProgressEvent;
    input: OrderProgressContextInput;
  },
  id: "orderProgression",
  initial: ORDER_PROGRESS_STATES.DRAFT,
  context: ({ input }) => normalizeOrderContext(input),
  states: {
    [ORDER_PROGRESS_STATES.DRAFT]: {
      on: {
        [ORDER_PROGRESS_EVENTS.START_ORDER]: ORDER_PROGRESS_STATES.AMOUNT,
        [ORDER_PROGRESS_EVENTS.CANCEL_ORDER]: {
          target: ORDER_PROGRESS_STATES.CANCELED,
        },
        [ORDER_PROGRESS_EVENTS.FAIL_ORDER]: {
          target: ORDER_PROGRESS_STATES.FAILED,
          actions: assign({
            failureReason: ({ event }) => normalizeOptionalText(event.reason) ?? "unspecified",
          }),
        },
      },
    },
    [ORDER_PROGRESS_STATES.AMOUNT]: {
      on: {
        [ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED]: {
          target: ORDER_PROGRESS_STATES.WALLET,
          guard: ({ event }) => Number.isSafeInteger(event.amountInCents) && event.amountInCents > 0,
          actions: assign({
            amountInCents: ({ event }) => event.amountInCents,
          }),
        },
        [ORDER_PROGRESS_EVENTS.CANCEL_ORDER]: {
          target: ORDER_PROGRESS_STATES.CANCELED,
        },
        [ORDER_PROGRESS_EVENTS.FAIL_ORDER]: {
          target: ORDER_PROGRESS_STATES.FAILED,
          actions: assign({
            failureReason: ({ event }) => normalizeOptionalText(event.reason) ?? "unspecified",
          }),
        },
      },
    },
    [ORDER_PROGRESS_STATES.WALLET]: {
      on: {
        [ORDER_PROGRESS_EVENTS.WALLET_RECEIVED]: {
          target: ORDER_PROGRESS_STATES.CONFIRMATION,
          guard: ({ event }) => hasText(event.walletAddress),
          actions: assign({
            walletAddress: ({ event }) => event.walletAddress.trim(),
          }),
        },
        [ORDER_PROGRESS_EVENTS.CANCEL_ORDER]: {
          target: ORDER_PROGRESS_STATES.CANCELED,
        },
        [ORDER_PROGRESS_EVENTS.FAIL_ORDER]: {
          target: ORDER_PROGRESS_STATES.FAILED,
          actions: assign({
            failureReason: ({ event }) => normalizeOptionalText(event.reason) ?? "unspecified",
          }),
        },
      },
    },
    [ORDER_PROGRESS_STATES.CONFIRMATION]: {
      on: {
        [ORDER_PROGRESS_EVENTS.CUSTOMER_CONFIRMED]: ORDER_PROGRESS_STATES.CREATING_DEPOSIT,
        [ORDER_PROGRESS_EVENTS.CANCEL_ORDER]: {
          target: ORDER_PROGRESS_STATES.CANCELED,
        },
        [ORDER_PROGRESS_EVENTS.FAIL_ORDER]: {
          target: ORDER_PROGRESS_STATES.FAILED,
          actions: assign({
            failureReason: ({ event }) => normalizeOptionalText(event.reason) ?? "unspecified",
          }),
        },
      },
    },
    [ORDER_PROGRESS_STATES.CREATING_DEPOSIT]: {
      on: {
        [ORDER_PROGRESS_EVENTS.DEPOSIT_CREATED]: {
          target: ORDER_PROGRESS_STATES.AWAITING_PAYMENT,
          guard: ({ event }) => hasText(event.depositEntryId),
          actions: assign({
            depositEntryId: ({ event }) => event.depositEntryId.trim() as DepositEntryId,
            qrId: ({ event }) => normalizeOptionalText(event.qrId),
          }),
        },
        [ORDER_PROGRESS_EVENTS.CANCEL_ORDER]: {
          target: ORDER_PROGRESS_STATES.CANCELED,
        },
        [ORDER_PROGRESS_EVENTS.FAIL_ORDER]: {
          target: ORDER_PROGRESS_STATES.FAILED,
          actions: assign({
            failureReason: ({ event }) => normalizeOptionalText(event.reason) ?? "unspecified",
          }),
        },
      },
    },
    [ORDER_PROGRESS_STATES.AWAITING_PAYMENT]: {
      on: {
        [ORDER_PROGRESS_EVENTS.PAYMENT_CONFIRMED]: ORDER_PROGRESS_STATES.COMPLETED,
        [ORDER_PROGRESS_EVENTS.CANCEL_ORDER]: {
          target: ORDER_PROGRESS_STATES.CANCELED,
        },
        [ORDER_PROGRESS_EVENTS.FAIL_ORDER]: {
          target: ORDER_PROGRESS_STATES.FAILED,
          actions: assign({
            failureReason: ({ event }) => normalizeOptionalText(event.reason) ?? "unspecified",
          }),
        },
      },
    },
    [ORDER_PROGRESS_STATES.COMPLETED]: {
      type: "final",
    },
    [ORDER_PROGRESS_STATES.FAILED]: {
      type: "final",
    },
    [ORDER_PROGRESS_STATES.CANCELED]: {
      type: "final",
    },
    [ORDER_PROGRESS_STATES.MANUAL_REVIEW]: {
      type: "final",
    },
  },
});

function createPersistedSnapshot(currentStep: OrderProgressState, context: OrderProgressContext) {
  return orderProgressMachine.resolveState({
    value: currentStep,
    context: normalizeOrderContext(context),
    historyValue: {},
    status: "active",
  });
}

function getOrderPatch(snapshot: { value: unknown; context: OrderProgressContext }): OrderProgressionPatch {
  const currentStep = requireKnownState(snapshot.value);
  const patch: OrderProgressionPatch = {
    currentStep,
    status: ORDER_STATUS_BY_STEP[currentStep],
  };

  if (snapshot.context.amountInCents !== null) {
    patch.amountInCents = snapshot.context.amountInCents;
  }

  if (snapshot.context.walletAddress !== null) {
    patch.walletAddress = snapshot.context.walletAddress;
  }

  return patch;
}

function toBoundaryResult(
  snapshot: { value: unknown; context: OrderProgressContext },
  previousStep: string | null = null,
): OrderProgressionResult {
  const currentStep = requireKnownState(snapshot.value);

  return {
    currentStep,
    previousStep,
    status: ORDER_STATUS_BY_STEP[currentStep],
    context: snapshot.context,
    persistenceGuard: {
      tenantId: snapshot.context.tenantId,
      orderId: snapshot.context.orderId,
      expectedCurrentStep: previousStep,
    },
    orderPatch: getOrderPatch(snapshot),
  };
}

export function createInitialOrderProgression(context: OrderProgressContextInput = {}): OrderProgressionResult {
  const normalizedContext = normalizeOrderContext(context);

  requireOrderBoundaryContext(normalizedContext);

  return toBoundaryResult(getInitialSnapshot(orderProgressMachine, normalizedContext));
}

/**
 * Avanca a progressao do pedido a partir de um estado persistido.
 *
 * A assinatura e propositalmente livre de objetos de transporte. Handlers de
 * Telegram, rotas HTTP e jobs de recheck devem converter seus inputs para
 * eventos de dominio antes de chamar esta funcao.
 */
export function advanceOrderProgression(input: {
  currentStep?: unknown;
  context?: OrderProgressContextInput;
  event: UnknownOrderProgressEvent;
}): OrderProgressionResult {
  const currentStep = input.currentStep ?? ORDER_PROGRESS_STATES.DRAFT;
  const machineStep = requireKnownState(currentStep);
  const event = requireKnownEvent(input.event);

  const normalizedContext = normalizeOrderContext(input.context);
  requireOrderBoundaryContext(normalizedContext, event);

  const currentSnapshot = createPersistedSnapshot(machineStep, normalizedContext);
  const nextSnapshot = getNextSnapshot(orderProgressMachine, currentSnapshot, event);

  if (nextSnapshot === currentSnapshot) {
    throw new OrderProgressionError(
      "invalid_order_transition",
      `Cannot apply ${event.type} while order is in ${machineStep}.`,
      {
        currentStep,
        machineStep,
        eventType: event.type,
      },
    );
  }

  return toBoundaryResult(nextSnapshot, typeof currentStep === "string" ? currentStep : String(currentStep));
}
