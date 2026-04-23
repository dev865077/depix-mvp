/**
 * Constantes puras do dominio de progressao de pedidos.
 *
 * Este arquivo nao importa XState, D1, Telegram, Hono ou clientes externos. Ele
 * existe para que a maquina de estados, repositories SQL e services compartilhem
 * o mesmo vocabulario sem criar acoplamento entre camadas de execucao.
 */

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

export type OrderProgressState = typeof ORDER_PROGRESS_STATES[keyof typeof ORDER_PROGRESS_STATES];

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

export type OrderProgressEvent = typeof ORDER_PROGRESS_EVENTS[keyof typeof ORDER_PROGRESS_EVENTS];

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

export type OrderStatusByStep = typeof ORDER_STATUS_BY_STEP[keyof typeof ORDER_STATUS_BY_STEP];

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

type LegacyOrderProgressStep = keyof typeof ORDER_PROGRESS_LEGACY_STEP_ALIASES;

/**
 * Passos canonicos que encerram a parte editavel do pedido.
 *
 * A lista e mantida no dominio para evitar divergencia entre SQL, Telegram,
 * jobs de reconciliacao e documentacao. `manual_review` e terminal porque o
 * proximo passo pertence ao operador, nao ao usuario no chat.
 */
export const ORDER_PROGRESS_TERMINAL_STATES = Object.freeze([
  ORDER_PROGRESS_STATES.COMPLETED,
  ORDER_PROGRESS_STATES.FAILED,
  ORDER_PROGRESS_STATES.CANCELED,
  ORDER_PROGRESS_STATES.MANUAL_REVIEW,
]);

const ORDER_PROGRESS_TERMINAL_STATE_SET = new Set<string>(ORDER_PROGRESS_TERMINAL_STATES);

/**
 * Valores persistidos que devem ser ignorados por lookups de pedido aberto.
 *
 * Inclui aliases legados como `paid`, porque a busca SQL ve o valor bruto em
 * `orders.current_step`; ela nao passa pela normalizacao JavaScript antes de
 * decidir se uma linha pode ser retomada pela conversa.
 */
export const ORDER_PROGRESS_TERMINAL_LOOKUP_STEPS = Object.freeze([
  ...ORDER_PROGRESS_TERMINAL_STATES,
  ...Object.entries(ORDER_PROGRESS_LEGACY_STEP_ALIASES)
    .filter(([, canonicalStep]) => ORDER_PROGRESS_TERMINAL_STATE_SET.has(canonicalStep))
    .map(([legacyStep]) => legacyStep),
]);

/**
 * Normaliza aliases legados para o passo canonico atual.
 *
 * @param {unknown} currentStep Passo persistido em `orders.current_step`.
 * @returns {unknown} Passo canonico quando o valor for alias conhecido.
 */
function isLegacyOrderProgressStep(currentStep: string): currentStep is LegacyOrderProgressStep {
  return Object.hasOwn(ORDER_PROGRESS_LEGACY_STEP_ALIASES, currentStep);
}

export function normalizePersistedOrderProgressStep(currentStep: unknown): unknown {
  return typeof currentStep === "string" && isLegacyOrderProgressStep(currentStep)
    ? ORDER_PROGRESS_LEGACY_STEP_ALIASES[currentStep]
    : currentStep;
}

/**
 * Classifica passos que encerram a conversa editavel do pedido.
 *
 * @param {unknown} currentStep Passo persistido em `orders.current_step`.
 * @returns {boolean} Verdadeiro quando o passo encerra o fluxo editavel.
 */
export function isTerminalOrderProgressStep(currentStep: unknown): boolean {
  const normalizedStep = normalizePersistedOrderProgressStep(currentStep);

  return typeof normalizedStep === "string"
    && ORDER_PROGRESS_TERMINAL_STATE_SET.has(normalizedStep);
}
