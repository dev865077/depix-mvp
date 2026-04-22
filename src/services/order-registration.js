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
  getLatestOrderByUser,
  getLatestOpenOrderByUser,
  hydrateOrderTelegramChatIdIfMissing,
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
const TELEGRAM_CHAT_BINDING_RESULTS = Object.freeze({
  MISSING_INCOMING_CHAT: "telegram_chat_missing",
  CREATED_WITH_CHAT: "telegram_chat_created",
  ALREADY_MATCHED: "telegram_chat_already_matched",
  HYDRATED_LEGACY: "telegram_chat_hydrated_legacy_order",
  HYDRATED_BY_CONCURRENT_REQUEST: "telegram_chat_hydrated_by_concurrent_request",
  MISMATCH: "telegram_chat_id_mismatch",
  HYDRATION_CONFLICT: "telegram_chat_hydration_conflict",
  ORDER_NOT_FOUND: "telegram_chat_order_not_found",
});

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
 * Normaliza o destino de chat do Telegram para persistencia.
 *
 * O Telegram pode enviar `chat.id` como numero ou string. Persistimos texto
 * para manter o contrato igual ao `user_id` e evitar comparacoes numericas
 * implicitas entre runtimes, testes e D1. Strings sao preservadas exatamente.
 * Numeros so sao aceitos dentro do intervalo seguro do JavaScript; se uma
 * borda receber um ID maior, ela deve passar o lexema bruto como string. Isso
 * evita persistir um destino arredondado e potencialmente errado.
 *
 * @param {string | number | undefined | null} telegramChatId Chat bruto do update.
 * @returns {string | null} Chat normalizado ou `null` quando ausente.
 */
function normalizeTelegramChatId(telegramChatId) {
  if (Number.isSafeInteger(telegramChatId)) {
    return String(telegramChatId);
  }

  if (typeof telegramChatId === "string" && telegramChatId.trim().length > 0) {
    return telegramChatId.trim();
  }

  return null;
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
 * Resolve o pedido mais relevante para consultas somente leitura no Telegram.
 *
 * A prioridade e: pedido aberto atual primeiro; se nao existir, ultimo pedido
 * conhecido do mesmo `tenantId + userId + channel`. Esse contrato sustenta
 * `/status`: o comando consegue explicar tanto fluxos em andamento quanto
 * resultados terminais sem criar, cancelar, reiniciar ou modificar linhas.
 *
 * @param {Parameters<typeof ensureTelegramOrderRegistration>[0]} input Dependencias e contexto da chamada atual.
 * @returns {Promise<{ order: Record<string, unknown> | null, source: "open" | "latest" | "none" }>} Pedido encontrado e origem da selecao.
 */
export async function getTelegramRelevantOrderForUser(input) {
  if (!input?.db) {
    throw new Error("Telegram relevant order lookup requires a configured D1 database.");
  }

  if (typeof input?.tenant?.tenantId !== "string" || input.tenant.tenantId.trim().length === 0) {
    throw new Error("Telegram relevant order lookup requires a resolved tenant.");
  }

  const userId = normalizeTelegramUserId(input.telegramUserId);
  const channel = input.channel ?? DEFAULT_ORDER_CHANNEL;
  const openOrder = await getLatestOpenOrderByUser(input.db, input.tenant.tenantId, userId, channel);

  if (openOrder) {
    return {
      order: openOrder,
      source: "open",
    };
  }

  const latestOrder = await getLatestOrderByUser(input.db, input.tenant.tenantId, userId, channel);

  return {
    order: latestOrder,
    source: latestOrder ? "latest" : "none",
  };
}

/**
 * Aplica o contrato de persistencia do `telegram_chat_id` para um pedido
 * selecionado.
 *
 * Esta funcao concentra a regra de negocio do issue #120. Ela nao conhece
 * grammY nem Eulen: recebe apenas o chat normalizado pela borda, decide se a
 * escrita e permitida, delega a atualizacao atomica ao repository e devolve uma
 * classificacao explicita para logging/controle do handler.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenant: { tenantId: string },
 *   order: Record<string, unknown>,
 *   channel: string,
 *   telegramChatId?: string | number | null
 * }} input Pedido selecionado e chat recebido.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   accepted: boolean,
 *   blocked: boolean,
 *   result: string,
 *   incomingTelegramChatId: string | null,
 *   persistedTelegramChatId: string | null
 * }>} Resultado classificado da associacao de chat.
 */
async function bindTelegramChatToOrder(input) {
  const incomingTelegramChatId = normalizeTelegramChatId(input.telegramChatId);
  const persistedTelegramChatId = normalizeTelegramChatId(input.order.telegramChatId);

  if (!incomingTelegramChatId) {
    return {
      order: input.order,
      accepted: true,
      blocked: false,
      result: TELEGRAM_CHAT_BINDING_RESULTS.MISSING_INCOMING_CHAT,
      incomingTelegramChatId,
      persistedTelegramChatId,
    };
  }

  if (persistedTelegramChatId === incomingTelegramChatId) {
    return {
      order: input.order,
      accepted: true,
      blocked: false,
      result: TELEGRAM_CHAT_BINDING_RESULTS.ALREADY_MATCHED,
      incomingTelegramChatId,
      persistedTelegramChatId,
    };
  }

  if (persistedTelegramChatId) {
    return {
      order: input.order,
      accepted: false,
      blocked: true,
      result: TELEGRAM_CHAT_BINDING_RESULTS.MISMATCH,
      incomingTelegramChatId,
      persistedTelegramChatId,
    };
  }

  const hydration = await hydrateOrderTelegramChatIdIfMissing(input.db, {
    tenantId: input.tenant.tenantId,
    orderId: String(input.order.orderId),
    userId: String(input.order.userId),
    channel: input.channel,
    telegramChatId: incomingTelegramChatId,
  });
  const classification = classifyTelegramChatHydrationResult({
    hydration,
    incomingTelegramChatId,
  });

  if (classification.notFound) {
    throw new Error("Telegram chat hydration failed because the selected order disappeared before update.");
  }

  return classification;
}

/**
 * Classifica o resultado da tentativa atomica de hidratar `telegram_chat_id`.
 *
 * Esta funcao e pura para que a regra mais sensivel do contrato seja testavel
 * sem criar uma corrida real no D1. A camada SQL continua responsavel pela
 * atomicidade; esta classificacao define o que fazer quando o update perdeu a
 * corrida e precisou reler o pedido.
 *
 * @param {{
 *   hydration: {
 *     order: Record<string, unknown> | null,
 *     didUpdate: boolean,
 *     notFound: boolean
 *   },
 *   incomingTelegramChatId: string
 * }} input Resultado do repository e chat recebido.
 * @returns {{
 *   order: Record<string, unknown> | null,
 *   accepted: boolean,
 *   blocked: boolean,
 *   notFound: boolean,
 *   result: string,
 *   incomingTelegramChatId: string,
 *   persistedTelegramChatId: string | null
 * }} Classificacao deterministica da tentativa.
 */
export function classifyTelegramChatHydrationResult(input) {
  if (input.hydration.notFound || !input.hydration.order) {
    return {
      order: null,
      accepted: false,
      blocked: true,
      notFound: true,
      result: TELEGRAM_CHAT_BINDING_RESULTS.ORDER_NOT_FOUND,
      incomingTelegramChatId: input.incomingTelegramChatId,
      persistedTelegramChatId: null,
    };
  }

  const persistedTelegramChatId = normalizeTelegramChatId(input.hydration.order.telegramChatId);

  if (input.hydration.didUpdate) {
    return {
      order: input.hydration.order,
      accepted: true,
      blocked: false,
      notFound: false,
      result: TELEGRAM_CHAT_BINDING_RESULTS.HYDRATED_LEGACY,
      incomingTelegramChatId: input.incomingTelegramChatId,
      persistedTelegramChatId,
    };
  }

  if (persistedTelegramChatId === input.incomingTelegramChatId) {
    return {
      order: input.hydration.order,
      accepted: true,
      blocked: false,
      notFound: false,
      result: TELEGRAM_CHAT_BINDING_RESULTS.HYDRATED_BY_CONCURRENT_REQUEST,
      incomingTelegramChatId: input.incomingTelegramChatId,
      persistedTelegramChatId,
    };
  }

  if (persistedTelegramChatId) {
    return {
      order: input.hydration.order,
      accepted: false,
      blocked: true,
      notFound: false,
      result: TELEGRAM_CHAT_BINDING_RESULTS.MISMATCH,
      incomingTelegramChatId: input.incomingTelegramChatId,
      persistedTelegramChatId,
    };
  }

  return {
    order: input.hydration.order,
    accepted: false,
    blocked: true,
    notFound: false,
    result: TELEGRAM_CHAT_BINDING_RESULTS.HYDRATION_CONFLICT,
    incomingTelegramChatId: input.incomingTelegramChatId,
    persistedTelegramChatId: null,
  };
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

function buildOrderCorrelationId() {
  return `corr_${crypto.randomUUID()}`;
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
 *   telegramChatId?: string | number | null,
 *   channel?: string,
 *   productType?: string
 * }} input Dependencias e contexto da chamada atual.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   created: boolean,
 *   chatBinding: Awaited<ReturnType<typeof bindTelegramChatToOrder>>
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
  const telegramChatId = normalizeTelegramChatId(input.telegramChatId);
  const channel = input.channel ?? DEFAULT_ORDER_CHANNEL;
  const productType = input.productType ?? DEFAULT_PRODUCT_TYPE;
  const existingOrder = await getLatestOpenOrderByUser(input.db, input.tenant.tenantId, userId, channel);

  if (existingOrder) {
    const chatBinding = await bindTelegramChatToOrder({
      db: input.db,
      tenant: input.tenant,
      order: existingOrder,
      channel,
      telegramChatId,
    });

    return {
      order: chatBinding.order,
      created: false,
      chatBinding,
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
    correlationId: buildOrderCorrelationId(),
    userId,
    channel,
    productType,
    telegramChatId,
    currentStep: initialProgression.orderPatch.currentStep,
    status: initialProgression.orderPatch.status,
  });

  return {
    order: createdOrder,
    created: true,
    chatBinding: {
      order: createdOrder,
      accepted: true,
      blocked: false,
      result: telegramChatId
        ? TELEGRAM_CHAT_BINDING_RESULTS.CREATED_WITH_CHAT
        : TELEGRAM_CHAT_BINDING_RESULTS.MISSING_INCOMING_CHAT,
      incomingTelegramChatId: telegramChatId,
      persistedTelegramChatId: normalizeTelegramChatId(createdOrder.telegramChatId),
    },
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
 *   conflict: boolean,
 *   chatBinding: Awaited<ReturnType<typeof bindTelegramChatToOrder>>
 * }>} Pedido aberto apos a tentativa idempotente de inicio.
 */
export async function startTelegramOrderConversation(input) {
  const registration = await ensureTelegramOrderRegistration(input);
  const tenantId = input.tenant.tenantId;
  const currentStep = normalizePersistedOrderProgressStep(registration.order.currentStep);

  if (registration.chatBinding.blocked) {
    return {
      order: registration.order,
      created: registration.created,
      started: false,
      conflict: false,
      chatBinding: registration.chatBinding,
    };
  }

  if (currentStep !== ORDER_PROGRESS_STATES.DRAFT) {
    return {
      order: registration.order,
      created: registration.created,
      started: false,
      conflict: false,
      chatBinding: registration.chatBinding,
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
    chatBinding: registration.chatBinding,
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
    ORDER_PROGRESS_STATES.AWAITING_PAYMENT,
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
