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
const ORDER_SELECT_SQL = `
  SELECT
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
  FROM orders
`;

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
