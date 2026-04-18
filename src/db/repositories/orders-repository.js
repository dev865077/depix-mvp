/**
 * Repositorio de pedidos.
 *
 * Aqui ficam as operacoes basicas da tabela `orders`. O objetivo deste modulo
 * e isolar SQL e mapeamento de colunas em um unico lugar, mantendo a camada de
 * servico focada em regras de negocio e fluxo conversacional.
 */
import { getAllowedPatchEntries } from "../client.js";

// Select base reaproveitado pelos readers do repositorio.
// Mantemos aliases em camelCase para devolver objetos prontos para o restante
// da aplicacao, sem espalhar nomes snake_case fora da borda SQL.
const ORDER_COLUMNS_SQL = `
    tenant_id AS tenantId,
    order_id AS orderId,
    user_id AS userId,
    channel AS channel,
    product_type AS productType,
    amount_in_cents AS amountInCents,
    wallet_address AS walletAddress,
    current_step AS currentStep,
    status AS status,
    split_address AS splitAddress,
    split_fee AS splitFee,
    created_at AS createdAt,
    updated_at AS updatedAt
`;

const ORDER_SELECT_SQL = `
  SELECT
    ${ORDER_COLUMNS_SQL}
  FROM orders
`;

const TERMINAL_ORDER_STEPS = Object.freeze([
  "completed",
  "failed",
  "canceled",
]);

const INSERT_ORDER_SQL = `
  INSERT INTO orders (
    tenant_id,
    order_id,
    user_id,
    channel,
    product_type,
    amount_in_cents,
    wallet_address,
    current_step,
    status,
    split_address,
    split_fee
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const ORDER_UPDATE_COLUMNS = {
  tenantId: "tenant_id",
  userId: "user_id",
  channel: "channel",
  productType: "product_type",
  amountInCents: "amount_in_cents",
  walletAddress: "wallet_address",
  currentStep: "current_step",
  status: "status",
  splitAddress: "split_address",
  splitFee: "split_fee",
  updatedAt: "updated_at",
};

/**
 * Aplica defaults operacionais para novos pedidos.
 *
 * Mesmo antes do fluxo completo com grammY/XState, o pedido precisa nascer com
 * um estado previsivel para nao depender de preenchimento manual em toda call.
 *
 * @param {Record<string, unknown>} input Payload recebido da camada acima.
 * @returns {Record<string, unknown>} Pedido normalizado.
 */
function normalizeOrderInput(input) {
  return {
    tenantId: input.tenantId,
    orderId: input.orderId,
    userId: input.userId,
    channel: input.channel ?? "telegram",
    productType: input.productType,
    amountInCents: input.amountInCents ?? null,
    walletAddress: input.walletAddress ?? null,
    currentStep: input.currentStep ?? "draft",
    status: input.status ?? "draft",
    splitAddress: input.splitAddress ?? null,
    splitFee: input.splitFee ?? null,
  };
}

/**
 * Cria um novo pedido e rele o registro na mesma rodada.
 *
 * O uso de `db.batch()` segue a orientacao da documentacao do projeto para
 * manter escrita e releitura fortemente agrupadas nas operacoes criticas.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {Record<string, unknown>} input Dados do pedido.
 * @returns {Promise<Record<string, unknown> | undefined>} Pedido persistido.
 */
export async function createOrder(db, input) {
  const order = normalizeOrderInput(input);
  const insertStatement = db.prepare(INSERT_ORDER_SQL).bind(
    order.tenantId,
    order.orderId,
    order.userId,
    order.channel,
    order.productType,
    order.amountInCents,
    order.walletAddress,
    order.currentStep,
    order.status,
    order.splitAddress,
    order.splitFee,
  );
  const selectStatement = db.prepare(`${ORDER_SELECT_SQL} WHERE tenant_id = ? AND order_id = ? LIMIT 1`).bind(
    order.tenantId,
    order.orderId,
  );
  const [, selectResult] = await db.batch([insertStatement, selectStatement]);

  return selectResult.results[0];
}

/**
 * Busca um pedido pelo par canonico `tenantId + orderId`.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador do pedido.
 * @returns {Promise<Record<string, unknown> | null>} Pedido encontrado.
 */
export async function getOrderById(db, tenantId, orderId) {
  return db.prepare(`${ORDER_SELECT_SQL} WHERE tenant_id = ? AND order_id = ? LIMIT 1`).bind(tenantId, orderId).first();
}

/**
 * Busca o pedido aberto mais recente de um usuario em um tenant/canal.
 *
 * Esta consulta existe para a borda conversacional do Telegram: quando o mesmo
 * usuario envia um novo update, o runtime precisa retomar o pedido ativo em vez
 * de criar uma duplicata sem contexto. Consideramos "aberto" todo pedido que
 * ainda nao entrou em um passo terminal conhecido.
 *
 * `julianday()` e usado para ordenar tanto timestamps nativos do SQLite quanto
 * timestamps ISO gravados por updates posteriores, mantendo a retomada
 * deterministica mesmo quando o registro ja sofreu mutacoes.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} userId Usuario do canal atual.
 * @param {string} [channel="telegram"] Canal logico do pedido.
 * @returns {Promise<Record<string, unknown> | null>} Pedido aberto mais recente, se existir.
 */
export async function getLatestOpenOrderByUser(db, tenantId, userId, channel = "telegram") {
  return db.prepare(
    `${ORDER_SELECT_SQL}
     WHERE tenant_id = ?
       AND user_id = ?
       AND channel = ?
       AND current_step NOT IN (?, ?, ?)
     ORDER BY julianday(updated_at) DESC, julianday(created_at) DESC
     LIMIT 1`,
  ).bind(
    tenantId,
    userId,
    channel,
    ...TERMINAL_ORDER_STEPS,
  ).first();
}

/**
 * Atualiza parcialmente um pedido sem permitir colunas fora da whitelist.
 *
 * O `tenantId` sempre participa do filtro para garantir isolamento entre os
 * bots que compartilham o mesmo Worker e o mesmo banco.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador do pedido.
 * @param {Record<string, unknown>} patch Campos permitidos para update.
 * @returns {Promise<Record<string, unknown> | null>} Pedido apos update.
 */
export async function updateOrderById(db, tenantId, orderId, patch) {
  const patchEntries = getAllowedPatchEntries(
    {
      ...patch,
      updatedAt: new Date().toISOString(),
    },
    ORDER_UPDATE_COLUMNS,
  );

  if (patchEntries.length === 0) {
    return getOrderById(db, tenantId, orderId);
  }

  // A montagem dinamica do SET acontece apenas em cima de campos ja validados
  // pela whitelist ORDER_UPDATE_COLUMNS.
  const setClause = patchEntries.map(([column]) => `${column} = ?`).join(", ");
  const values = patchEntries.map(([, value]) => value);
  const updateStatement = db.prepare(`UPDATE orders SET ${setClause} WHERE tenant_id = ? AND order_id = ?`).bind(
    ...values,
    tenantId,
    orderId,
  );
  const selectStatement = db.prepare(`${ORDER_SELECT_SQL} WHERE tenant_id = ? AND order_id = ? LIMIT 1`).bind(
    tenantId,
    orderId,
  );
  const [, selectResult] = await db.batch([updateStatement, selectStatement]);

  return selectResult.results[0];
}

/**
 * Atualiza um pedido somente se ele ainda estiver no passo esperado.
 *
 * Esta e a operacao recomendada para aplicar saidas da maquina XState. O
 * `expectedCurrentStep` funciona como compare-and-set simples no D1: se outro
 * request ja tiver avancado o pedido, o `UPDATE` nao toca em nenhuma linha e a
 * camada de servico recebe `conflict: true` para observar/reagir sem sobrescrever
 * o estado mais novo.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador do pedido.
 * @param {string} expectedCurrentStep Passo que a camada leu antes da transicao.
 * @param {Record<string, unknown>} patch Campos permitidos para update.
 * @returns {Promise<{
 *   order: Record<string, unknown> | null,
 *   didUpdate: boolean,
 *   conflict: boolean,
 *   notFound: boolean,
 *   reason: "updated" | "empty_patch" | "step_conflict" | "not_found"
 * }>}
 */
export async function updateOrderByIdWithStepGuard(db, tenantId, orderId, expectedCurrentStep, patch) {
  const patchEntries = getAllowedPatchEntries(
    {
      ...patch,
      updatedAt: new Date().toISOString(),
    },
    ORDER_UPDATE_COLUMNS,
  );

  if (patchEntries.length === 0) {
    return {
      order: await getOrderById(db, tenantId, orderId),
      didUpdate: false,
      conflict: false,
      notFound: false,
      reason: "empty_patch",
    };
  }

  // A guarda de current_step transforma a escrita em uma transicao condicional.
  // Isso protege contra retries, webhooks duplicados e requests concorrentes.
  const setClause = patchEntries.map(([column]) => `${column} = ?`).join(", ");
  const values = patchEntries.map(([, value]) => value);
  const updatedOrder = await db
    .prepare(
      `UPDATE orders
       SET ${setClause}
       WHERE tenant_id = ? AND order_id = ? AND current_step = ?
       RETURNING ${ORDER_COLUMNS_SQL}`,
    )
    .bind(...values, tenantId, orderId, expectedCurrentStep)
    .first();

  if (updatedOrder) {
    return {
      order: updatedOrder,
      didUpdate: true,
      conflict: false,
      notFound: false,
      reason: "updated",
    };
  }

  const currentOrder = await db.prepare(`${ORDER_SELECT_SQL} WHERE tenant_id = ? AND order_id = ? LIMIT 1`).bind(
    tenantId,
    orderId,
  ).first();

  return {
    order: currentOrder ?? null,
    didUpdate: false,
    conflict: currentOrder !== null,
    notFound: currentOrder === null,
    reason: currentOrder ? "step_conflict" : "not_found",
  };
}
