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

export const ORDER_PROGRESS_STATES = Object.freeze({
  DRAFT: "draft",
  AMOUNT: "amount",
  WALLET: "wallet",
  CONFIRMATION: "confirmation",
  CREATING_DEPOSIT: "creating_deposit",
  AWAITING_PAYMENT: "awaiting_payment",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELED: "canceled",
  MANUAL_REVIEW: "manual_review",
});

export const ORDER_PROGRESS_EVENTS = Object.freeze({
  START_ORDER: "START_ORDER",
  AMOUNT_RECEIVED: "AMOUNT_RECEIVED",
  WALLET_RECEIVED: "WALLET_RECEIVED",
  CUSTOMER_CONFIRMED: "CUSTOMER_CONFIRMED",
  DEPOSIT_CREATED: "DEPOSIT_CREATED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  FAIL_ORDER: "FAIL_ORDER",
  CANCEL_ORDER: "CANCEL_ORDER",
});

export const ORDER_STATUS_BY_STEP = Object.freeze({
  [ORDER_PROGRESS_STATES.DRAFT]: "draft",
  [ORDER_PROGRESS_STATES.AMOUNT]: "draft",
  [ORDER_PROGRESS_STATES.WALLET]: "draft",
  [ORDER_PROGRESS_STATES.CONFIRMATION]: "draft",
  [ORDER_PROGRESS_STATES.CREATING_DEPOSIT]: "processing",
  [ORDER_PROGRESS_STATES.AWAITING_PAYMENT]: "pending",
  [ORDER_PROGRESS_STATES.COMPLETED]: "paid",
  [ORDER_PROGRESS_STATES.FAILED]: "failed",
  [ORDER_PROGRESS_STATES.CANCELED]: "canceled",
  [ORDER_PROGRESS_STATES.MANUAL_REVIEW]: "under_review",
});

export const ORDER_PROGRESS_LEGACY_STEP_ALIASES = Object.freeze({
  awaiting_amount: ORDER_PROGRESS_STATES.AMOUNT,
  collecting_amount: ORDER_PROGRESS_STATES.AMOUNT,
  awaiting_wallet: ORDER_PROGRESS_STATES.WALLET,
  collecting_wallet: ORDER_PROGRESS_STATES.WALLET,
  review: ORDER_PROGRESS_STATES.CONFIRMATION,
  awaiting_confirmation: ORDER_PROGRESS_STATES.CONFIRMATION,
  deposit_creation: ORDER_PROGRESS_STATES.CREATING_DEPOSIT,
  pending_payment: ORDER_PROGRESS_STATES.AWAITING_PAYMENT,
  paid: ORDER_PROGRESS_STATES.COMPLETED,
});

const KNOWN_STATES = new Set(Object.values(ORDER_PROGRESS_STATES));
const KNOWN_EVENTS = new Set(Object.values(ORDER_PROGRESS_EVENTS));

/**
 * Erro de dominio usado pela camada de aplicacao para distinguir falha de
 * transicao de erro inesperado de runtime.
 */
export class OrderProgressionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OrderProgressionError";
    this.code = code;
    this.details = details;
  }
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptionalText(value) {
  return hasText(value) ? value.trim() : null;
}

function normalizeOrderContext(input = {}) {
  return {
    tenantId: normalizeOptionalText(input.tenantId),
    orderId: normalizeOptionalText(input.orderId),
    userId: normalizeOptionalText(input.userId),
    amountInCents: Number.isSafeInteger(input.amountInCents) ? input.amountInCents : null,
    walletAddress: normalizeOptionalText(input.walletAddress),
    depositEntryId: normalizeOptionalText(input.depositEntryId),
    qrId: normalizeOptionalText(input.qrId),
    failureReason: normalizeOptionalText(input.failureReason),
  };
}

function requireOrderBoundaryContext(context, event) {
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

export function normalizePersistedOrderProgressStep(currentStep) {
  return ORDER_PROGRESS_LEGACY_STEP_ALIASES[currentStep] ?? currentStep;
}

function requireKnownState(currentStep) {
  const normalizedStep = normalizePersistedOrderProgressStep(currentStep);

  if (!KNOWN_STATES.has(normalizedStep)) {
    throw new OrderProgressionError("unknown_order_step", `Unknown order step: ${currentStep}.`, { currentStep });
  }

  return normalizedStep;
}

function requireKnownEvent(event) {
  if (!event || !KNOWN_EVENTS.has(event.type)) {
    throw new OrderProgressionError("unknown_order_event", `Unknown order event: ${event?.type ?? "missing"}.`, {
      eventType: event?.type,
    });
  }
}

const canAcceptAmount = ({ event }) => Number.isSafeInteger(event.amountInCents) && event.amountInCents > 0;
const canAcceptWallet = ({ event }) => hasText(event.walletAddress);
const canAcceptDeposit = ({ event }) => hasText(event.depositEntryId);

const cancelOrFailTransitions = {
  [ORDER_PROGRESS_EVENTS.CANCEL_ORDER]: {
    target: ORDER_PROGRESS_STATES.CANCELED,
  },
  [ORDER_PROGRESS_EVENTS.FAIL_ORDER]: {
    target: ORDER_PROGRESS_STATES.FAILED,
    actions: assign({
      failureReason: ({ event }) => normalizeOptionalText(event.reason) ?? "unspecified",
    }),
  },
};

/**
 * Maquina XState do primeiro caminho feliz do pedido.
 *
 * Estados persistem em `orders.current_step`; status derivados persistem em
 * `orders.status`. A maquina so calcula transicoes validas, enquanto services
 * separados continuam responsaveis por side effects como criar deposito na
 * Eulen ou gravar no D1.
 */
export const orderProgressMachine = createMachine({
  id: "orderProgression",
  initial: ORDER_PROGRESS_STATES.DRAFT,
  context: ({ input }) => normalizeOrderContext(input),
  states: {
    [ORDER_PROGRESS_STATES.DRAFT]: {
      on: {
        [ORDER_PROGRESS_EVENTS.START_ORDER]: ORDER_PROGRESS_STATES.AMOUNT,
        ...cancelOrFailTransitions,
      },
    },
    [ORDER_PROGRESS_STATES.AMOUNT]: {
      on: {
        [ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED]: {
          target: ORDER_PROGRESS_STATES.WALLET,
          guard: canAcceptAmount,
          actions: assign({
            amountInCents: ({ event }) => event.amountInCents,
          }),
        },
        ...cancelOrFailTransitions,
      },
    },
    [ORDER_PROGRESS_STATES.WALLET]: {
      on: {
        [ORDER_PROGRESS_EVENTS.WALLET_RECEIVED]: {
          target: ORDER_PROGRESS_STATES.CONFIRMATION,
          guard: canAcceptWallet,
          actions: assign({
            walletAddress: ({ event }) => event.walletAddress.trim(),
          }),
        },
        ...cancelOrFailTransitions,
      },
    },
    [ORDER_PROGRESS_STATES.CONFIRMATION]: {
      on: {
        [ORDER_PROGRESS_EVENTS.CUSTOMER_CONFIRMED]: ORDER_PROGRESS_STATES.CREATING_DEPOSIT,
        ...cancelOrFailTransitions,
      },
    },
    [ORDER_PROGRESS_STATES.CREATING_DEPOSIT]: {
      on: {
        [ORDER_PROGRESS_EVENTS.DEPOSIT_CREATED]: {
          target: ORDER_PROGRESS_STATES.AWAITING_PAYMENT,
          guard: canAcceptDeposit,
          actions: assign({
            depositEntryId: ({ event }) => event.depositEntryId.trim(),
            qrId: ({ event }) => normalizeOptionalText(event.qrId),
          }),
        },
        ...cancelOrFailTransitions,
      },
    },
    [ORDER_PROGRESS_STATES.AWAITING_PAYMENT]: {
      on: {
        [ORDER_PROGRESS_EVENTS.PAYMENT_CONFIRMED]: ORDER_PROGRESS_STATES.COMPLETED,
        ...cancelOrFailTransitions,
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

function createPersistedSnapshot(currentStep, context) {
  return orderProgressMachine.restoreSnapshot({
    status: "active",
    value: currentStep,
    context: normalizeOrderContext(context),
    children: {},
    historyValue: {},
    tags: [],
  });
}

function getOrderPatch(snapshot) {
  const currentStep = snapshot.value;
  const patch = {
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

function toBoundaryResult(snapshot, previousStep = null) {
  return {
    currentStep: snapshot.value,
    previousStep,
    status: ORDER_STATUS_BY_STEP[snapshot.value],
    context: snapshot.context,
    // Services devem usar esta guarda no WHERE do update para impedir que um
    // request atrasado sobrescreva uma transicao mais nova do mesmo pedido.
    persistenceGuard: {
      tenantId: snapshot.context.tenantId,
      orderId: snapshot.context.orderId,
      expectedCurrentStep: previousStep,
    },
    orderPatch: getOrderPatch(snapshot),
  };
}

export function createInitialOrderProgression(context = {}) {
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
export function advanceOrderProgression({ currentStep = ORDER_PROGRESS_STATES.DRAFT, context = {}, event }) {
  const machineStep = requireKnownState(currentStep);
  requireKnownEvent(event);

  const normalizedContext = normalizeOrderContext(context);
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

  return toBoundaryResult(nextSnapshot, currentStep);
}
