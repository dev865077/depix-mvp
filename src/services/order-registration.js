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
