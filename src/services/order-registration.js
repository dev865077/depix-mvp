/**
 * Service de materializacao do pedido inicial do Telegram.
 *
 * A responsabilidade desta camada e pequena, mas importante:
 * - reutilizar um pedido aberto quando o usuario volta ao bot
 * - criar um novo pedido persistido quando ainda nao existe contexto previo
 * - garantir que o pedido nasca com `tenantId`, `orderId` e estado inicial
 *   derivados do contrato canonico da maquina XState
 *
 * O service continua deliberadamente sem acoplamento a grammY. A borda do
 * Telegram apenas extrai `tenant`, `userId` e `db`, e delega para este modulo.
 */
import {
  createOrder,
  getLatestOpenOrderByUser,
  updateOrderByIdWithStepGuard,
} from "../db/repositories/orders-repository.js";
import {
  advanceOrderProgression,
  createInitialOrderProgression,
  ORDER_PROGRESS_EVENTS,
  ORDER_PROGRESS_STATES,
  normalizePersistedOrderProgressStep,
} from "../order-flow/order-progress-machine.js";
import { parseTelegramBrlAmount } from "../telegram/brl-amount.js";
import { parseTelegramWalletAddress } from "../telegram/wallet-address.js";

const DEFAULT_ORDER_CHANNEL = "telegram";
const DEFAULT_PRODUCT_TYPE = "depix";

/**
 * Normaliza o identificador do usuario do Telegram para o contrato do banco.
 *
 * O Telegram entrega IDs numericos, enquanto o schema do projeto persiste
 * `user_id` como texto. Centralizar essa conversao evita comparacoes
 * inconsistentes entre lookup e insert.
 *
 * @param {string | number} telegramUserId Identificador bruto do Telegram.
 * @returns {string} Usuario normalizado para persistencia.
 */
function normalizeTelegramUserId(telegramUserId) {
  if (
    (typeof telegramUserId !== "string" || telegramUserId.trim().length === 0)
    && !Number.isSafeInteger(telegramUserId)
  ) {
    throw new Error("Telegram order registration requires a valid userId.");
  }

  return String(telegramUserId).trim();
}

/**
 * Resolve apenas o pedido aberto atual do usuario sem criar um novo agregado.
 *
 * Esta leitura existe para comandos de controle, como `cancelar` e
 * `recomecar`. Nesses casos, a borda do Telegram precisa observar o estado
 * atual antes de decidir se deve cancelar, reiniciar ou apenas orientar o
 * usuario, sem materializar um pedido novo por acidente.
 *
 * @param {Parameters<typeof ensureTelegramOrderRegistration>[0]} input Dependencias e contexto da chamada atual.
 * @returns {Promise<Record<string, unknown> | null>} Pedido aberto mais recente do usuario, se existir.
 */
export async function getTelegramOpenOrderForUser(input) {
  if (!input?.db) {
    throw new Error("Telegram open order lookup requires a configured D1 database.");
  }

  if (typeof input?.tenant?.tenantId !== "string" || input.tenant.tenantId.trim().length === 0) {
    throw new Error("Telegram open order lookup requires a resolved tenant.");
  }

  const userId = normalizeTelegramUserId(input.telegramUserId);
  const channel = input.channel ?? DEFAULT_ORDER_CHANNEL;

  return getLatestOpenOrderByUser(input.db, input.tenant.tenantId, userId, channel);
}

/**
 * Gera um `orderId` interno estavel o bastante para rastreabilidade.
 *
 * O prefixo explicita o agregado no banco e facilita leitura operacional em
 * logs, dumps e respostas de suporte.
 *
 * @returns {string} Identificador interno do pedido.
 */
function buildInternalOrderId() {
  return `order_${crypto.randomUUID()}`;
}

/**
 * Garante que exista um pedido reutilizavel para o usuario atual.
 *
 * Se um pedido aberto ja existir, ele e retomado. Caso contrario, um novo
 * pedido nasce em `draft` a partir do contrato canonico da maquina XState.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenant: { tenantId: string },
 *   telegramUserId: string | number,
 *   channel?: string,
 *   productType?: string
 * }} input Dependencias e contexto da chamada atual.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   created: boolean
 * }>} Pedido ativo pronto para continuidade do fluxo.
 */
export async function ensureTelegramOrderRegistration(input) {
  if (!input?.db) {
    throw new Error("Telegram order registration requires a configured D1 database.");
  }

  if (typeof input?.tenant?.tenantId !== "string" || input.tenant.tenantId.trim().length === 0) {
    throw new Error("Telegram order registration requires a resolved tenant.");
  }

  const userId = normalizeTelegramUserId(input.telegramUserId);
  const channel = input.channel ?? DEFAULT_ORDER_CHANNEL;
  const productType = input.productType ?? DEFAULT_PRODUCT_TYPE;
  const existingOrder = await getLatestOpenOrderByUser(input.db, input.tenant.tenantId, userId, channel);

  if (existingOrder) {
    return {
      order: existingOrder,
      created: false,
    };
  }

  const initialProgression = createInitialOrderProgression({
    tenantId: input.tenant.tenantId,
    orderId: buildInternalOrderId(),
    userId,
  });
  const createdOrder = await createOrder(input.db, {
    tenantId: input.tenant.tenantId,
    orderId: initialProgression.context.orderId,
    userId,
    channel,
    productType,
    currentStep: initialProgression.orderPatch.currentStep,
    status: initialProgression.orderPatch.status,
  });

  return {
    order: createdOrder,
    created: true,
  };
}

/**
 * Materializa o pedido conversacional e aplica o primeiro evento de negocio.
 *
 * `ensureTelegramOrderRegistration()` cuida apenas de encontrar/criar o
 * agregado. Esta funcao adiciona a semantica do comando de entrada do bot:
 * quando o pedido ainda esta em `draft`, o evento canonico `START_ORDER`
 * avanca a maquina para `amount` e a persistencia usa compare-and-set pelo
 * passo lido. Assim, retries do Telegram e dois webhooks concorrentes nao
 * criam pedidos duplicados nem sobrescrevem uma transicao mais nova.
 *
 * @param {Parameters<typeof ensureTelegramOrderRegistration>[0]} input Dependencias e contexto da chamada atual.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   created: boolean,
 *   started: boolean,
 *   conflict: boolean
 * }>} Pedido aberto apos a tentativa idempotente de inicio.
 */
export async function startTelegramOrderConversation(input) {
  const registration = await ensureTelegramOrderRegistration(input);
  const tenantId = input.tenant.tenantId;
  const currentStep = normalizePersistedOrderProgressStep(registration.order.currentStep);

  if (currentStep !== ORDER_PROGRESS_STATES.DRAFT) {
    return {
      order: registration.order,
      created: registration.created,
      started: false,
      conflict: false,
    };
  }

  const progression = advanceOrderProgression({
    currentStep: registration.order.currentStep,
    context: {
      tenantId,
      orderId: registration.order.orderId,
      userId: registration.order.userId,
      amountInCents: registration.order.amountInCents,
      walletAddress: registration.order.walletAddress,
    },
    event: {
      type: ORDER_PROGRESS_EVENTS.START_ORDER,
      tenantId,
    },
  });
  const write = await updateOrderByIdWithStepGuard(
    input.db,
    tenantId,
    registration.order.orderId,
    registration.order.currentStep,
    progression.orderPatch,
  );

  if (write.notFound) {
    throw new Error("Telegram order start failed because the registered order disappeared before update.");
  }

  return {
    order: write.order,
    created: registration.created,
    started: write.didUpdate,
    conflict: write.conflict,
  };
}

/**
 * Aplica o valor informado pelo usuario ao pedido aberto no Telegram.
 *
 * A funcao parte de um pedido ja materializado pelo fluxo conversacional. Ela
 * so aceita escrita quando o passo persistido ainda e `amount`; qualquer outro
 * passo e tratado como "fora de escopo desta mensagem" e devolvido sem mutacao.
 * Isso permite que replays de mensagens antigas nao sobrescrevam um pedido que
 * ja avancou para `wallet` ou alem.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenant: { tenantId: string },
 *   order: Record<string, unknown>,
 *   rawText: string
 * }} input Dependencias e mensagem recebida.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   accepted: boolean,
 *   conflict: boolean,
 *   parseResult: ReturnType<typeof parseTelegramBrlAmount> | null
 * }>} Resultado da tentativa de gravar o valor.
 */
export async function receiveTelegramOrderAmount(input) {
  const currentStep = normalizePersistedOrderProgressStep(input.order.currentStep);

  if (currentStep !== ORDER_PROGRESS_STATES.AMOUNT) {
    return {
      order: input.order,
      accepted: false,
      conflict: false,
      parseResult: null,
    };
  }

  const parseResult = parseTelegramBrlAmount(input.rawText);

  if (!parseResult.ok) {
    return {
      order: input.order,
      accepted: false,
      conflict: false,
      parseResult,
    };
  }

  const progression = advanceOrderProgression({
    currentStep: input.order.currentStep,
    context: {
      tenantId: input.tenant.tenantId,
      orderId: input.order.orderId,
      userId: input.order.userId,
      amountInCents: input.order.amountInCents,
      walletAddress: input.order.walletAddress,
    },
    event: {
      type: ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED,
      tenantId: input.tenant.tenantId,
      amountInCents: parseResult.amountInCents,
    },
  });
  const write = await updateOrderByIdWithStepGuard(
    input.db,
    input.tenant.tenantId,
    input.order.orderId,
    input.order.currentStep,
    progression.orderPatch,
  );

  if (write.notFound) {
    throw new Error("Telegram amount update failed because the order disappeared before update.");
  }

  return {
    order: write.order,
    accepted: write.didUpdate,
    conflict: write.conflict,
    parseResult,
  };
}

/**
 * Aplica o endereco DePix/Liquid informado pelo usuario ao pedido aberto.
 *
 * A escrita segue o mesmo padrao das demais transicoes conversacionais: parser
 * conservador na borda, evento canonico da maquina XState e persistencia com
 * guarda de passo. Se uma mensagem antiga chegar depois do pedido avancar para
 * `confirmation`, a funcao devolve o pedido atual sem sobrescrever o endereco.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenant: { tenantId: string },
 *   order: Record<string, unknown>,
 *   rawText: string
 * }} input Dependencias e mensagem recebida.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   accepted: boolean,
 *   conflict: boolean,
 *   parseResult: ReturnType<typeof parseTelegramWalletAddress> | null
 * }>} Resultado da tentativa de gravar o endereco.
 */
export async function receiveTelegramOrderWallet(input) {
  const currentStep = normalizePersistedOrderProgressStep(input.order.currentStep);

  if (currentStep !== ORDER_PROGRESS_STATES.WALLET) {
    return {
      order: input.order,
      accepted: false,
      conflict: false,
      parseResult: null,
    };
  }

  const parseResult = parseTelegramWalletAddress(input.rawText);

  if (!parseResult.ok) {
    return {
      order: input.order,
      accepted: false,
      conflict: false,
      parseResult,
    };
  }

  const progression = advanceOrderProgression({
    currentStep: input.order.currentStep,
    context: {
      tenantId: input.tenant.tenantId,
      orderId: input.order.orderId,
      userId: input.order.userId,
      amountInCents: input.order.amountInCents,
      walletAddress: input.order.walletAddress,
    },
    event: {
      type: ORDER_PROGRESS_EVENTS.WALLET_RECEIVED,
      tenantId: input.tenant.tenantId,
      walletAddress: parseResult.walletAddress,
    },
  });
  const write = await updateOrderByIdWithStepGuard(
    input.db,
    input.tenant.tenantId,
    input.order.orderId,
    input.order.currentStep,
    progression.orderPatch,
  );

  if (write.notFound) {
    throw new Error("Telegram wallet update failed because the order disappeared before update.");
  }

  return {
    order: write.order,
    accepted: write.didUpdate,
    conflict: write.conflict,
    parseResult,
  };
}

/**
 * Cancela um pedido aberto do Telegram por compare-and-set do passo atual.
 *
 * A rotina cobre apenas estados ainda abertos para intervencao do usuario.
 * Isso evita sobrescrever agregados ja pagos, falhos ou encerrados por outra
 * parte do sistema.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenant: { tenantId: string },
 *   order: Record<string, unknown>
 * }} input Dependencias do pedido atual.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   accepted: boolean,
 *   conflict: boolean
 * }>} Resultado da tentativa de cancelamento.
 */
export async function cancelTelegramOpenOrder(input) {
  const currentStep = normalizePersistedOrderProgressStep(input.order.currentStep);
  const cancellableSteps = new Set([
    ORDER_PROGRESS_STATES.AMOUNT,
    ORDER_PROGRESS_STATES.WALLET,
    ORDER_PROGRESS_STATES.CONFIRMATION,
  ]);

  if (!cancellableSteps.has(currentStep)) {
    return {
      order: input.order,
      accepted: false,
      conflict: false,
    };
  }

  const progression = advanceOrderProgression({
    currentStep: input.order.currentStep,
    context: {
      tenantId: input.tenant.tenantId,
      orderId: input.order.orderId,
      userId: input.order.userId,
      amountInCents: input.order.amountInCents,
      walletAddress: input.order.walletAddress,
    },
    event: {
      type: ORDER_PROGRESS_EVENTS.CANCEL_ORDER,
      tenantId: input.tenant.tenantId,
    },
  });
  const write = await updateOrderByIdWithStepGuard(
    input.db,
    input.tenant.tenantId,
    input.order.orderId,
    input.order.currentStep,
    progression.orderPatch,
  );

  if (write.notFound) {
    throw new Error("Telegram order cancellation failed because the order disappeared before update.");
  }

  return {
    order: write.order,
    accepted: write.didUpdate,
    conflict: write.conflict,
  };
}

/**
 * Reinicia a conversa do Telegram cancelando o pedido aberto e abrindo outro.
 *
 * O fluxo deliberadamente falha fechado quando o pedido atual nao e
 * cancelavel. Assim, um usuario com Pix ja emitido nao recebe um pedido novo
 * por cima de um estado financeiro que ainda esta em curso.
 *
 * @param {Parameters<typeof ensureTelegramOrderRegistration>[0]} input Dependencias e contexto do usuario atual.
 * @param {{
 *   startConversation?: typeof startTelegramOrderConversation
 * }=} options Dependencias opcionais para isolar falhas do segundo passo.
 * @returns {Promise<{
 *   previousOrder: Record<string, unknown> | null,
 *   order: Record<string, unknown> | null,
 *   restarted: boolean,
 *   created: boolean,
 *   started: boolean,
 *   conflict: boolean,
 *   restartFailed: boolean,
 *   restartFailureReason?: string
 * }>} Resultado do reinicio e o novo pedido, quando houver.
 */
export async function restartTelegramOpenOrderConversation(input, options = {}) {
  const openOrder = await getTelegramOpenOrderForUser(input);

  if (!openOrder) {
    return {
      previousOrder: null,
      order: null,
      restarted: false,
      created: false,
      started: false,
      conflict: false,
      restartFailed: false,
    };
  }

  const cancellation = await cancelTelegramOpenOrder({
    db: input.db,
    tenant: input.tenant,
    order: openOrder,
  });

  if (!cancellation.accepted) {
    return {
      previousOrder: cancellation.order,
      order: cancellation.order,
      restarted: false,
      created: false,
      started: false,
      conflict: cancellation.conflict,
      restartFailed: false,
    };
  }

  const startConversation = options.startConversation ?? startTelegramOrderConversation;
  let restartedOrder;

  try {
    restartedOrder = await startConversation(input);
  } catch (error) {
    return {
      previousOrder: cancellation.order,
      order: null,
      restarted: false,
      created: false,
      started: false,
      conflict: false,
      restartFailed: true,
      restartFailureReason: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    previousOrder: cancellation.order,
    order: restartedOrder.order,
    restarted: true,
    created: restartedOrder.created,
    started: restartedOrder.started,
    conflict: restartedOrder.conflict,
    restartFailed: false,
  };
}
