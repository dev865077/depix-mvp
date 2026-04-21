/**
 * Repositorio de pedidos.
 *
 * Aqui ficam as operacoes basicas da tabela `orders`. O objetivo deste modulo
 * e isolar SQL e mapeamento de colunas em um unico lugar, mantendo a camada de
 * servico focada em regras de negocio e fluxo conversacional.
 */
import { getAllowedPatchEntries } from "../client.js";
import { ORDER_PROGRESS_TERMINAL_LOOKUP_STEPS } from "../../order-flow/order-progress-constants.js";
// Select base reaproveitado pelos readers do repositorio.
// Mantemos aliases em camelCase para devolver objetos prontos para o restante
// da aplicacao, sem espalhar nomes snake_case fora da borda SQL.
const ORDER_COLUMNS_SQL = `
    tenant_id AS tenantId,
    order_id AS orderId,
    user_id AS userId,
    channel AS channel,
    product_type AS productType,
    telegram_chat_id AS telegramChatId,
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
const TERMINAL_ORDER_STEPS = ORDER_PROGRESS_TERMINAL_LOOKUP_STEPS;
const INSERT_ORDER_SQL = `
  INSERT INTO orders (
    tenant_id,
    order_id,
    user_id,
    channel,
    product_type,
    telegram_chat_id,
    amount_in_cents,
    wallet_address,
    current_step,
    status,
    split_address,
    split_fee
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const ORDER_UPDATE_COLUMNS = {
    tenantId: "tenant_id",
    userId: "user_id",
    channel: "channel",
    productType: "product_type",
    telegramChatId: "telegram_chat_id",
    amountInCents: "amount_in_cents",
    walletAddress: "wallet_address",
    currentStep: "current_step",
    status: "status",
    splitAddress: "split_address",
    splitFee: "split_fee",
    updatedAt: "updated_at",
};
function toRequiredString(value) {
    return String(value);
}
function toNullableString(value) {
    return value === null || value === undefined ? null : String(value);
}
/**
 * Aplica defaults operacionais para novos pedidos.
 *
 * Mesmo antes do fluxo completo com grammY/XState, o pedido precisa nascer com
 * um estado previsivel para nao depender de preenchimento manual em toda call.
 *
 * @param {CreateOrderInput} input Payload recebido da camada acima.
 * @returns {Required<CreateOrderInput>} Pedido normalizado.
 */
function normalizeOrderInput(input) {
    return {
        tenantId: toRequiredString(input.tenantId),
        orderId: toRequiredString(input.orderId),
        userId: toRequiredString(input.userId),
        channel: toRequiredString(input.channel ?? "telegram"),
        productType: toRequiredString(input.productType),
        telegramChatId: toNullableString(input.telegramChatId),
        amountInCents: input.amountInCents ?? null,
        walletAddress: toNullableString(input.walletAddress),
        currentStep: toRequiredString(input.currentStep ?? "draft"),
        status: toRequiredString(input.status ?? "draft"),
        splitAddress: toNullableString(input.splitAddress),
        splitFee: toNullableString(input.splitFee),
    };
}
/**
 * Cria um novo pedido e rele o registro na mesma rodada.
 *
 * O uso de `db.batch()` segue a orientacao da documentacao do projeto para
 * manter escrita e releitura fortemente agrupadas nas operacoes criticas.
 *
 * @param {D1Database} db Database D1.
 * @param {CreateOrderInput} input Dados do pedido.
 * @returns {Promise<OrderRecord | undefined>} Pedido persistido.
 */
export async function createOrder(db, input) {
    const order = normalizeOrderInput(input);
    const insertStatement = db.prepare(INSERT_ORDER_SQL).bind(order.tenantId, order.orderId, order.userId, order.channel, order.productType, order.telegramChatId, order.amountInCents, order.walletAddress, order.currentStep, order.status, order.splitAddress, order.splitFee);
    const selectStatement = db.prepare(`${ORDER_SELECT_SQL} WHERE tenant_id = ? AND order_id = ? LIMIT 1`).bind(order.tenantId, order.orderId);
    const [, selectResult] = await db.batch([insertStatement, selectStatement]);
    return selectResult?.results[0];
}
/**
 * Busca um pedido pelo par canonico `tenantId + orderId`.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador do pedido.
 * @returns {Promise<OrderRecord | null>} Pedido encontrado.
 */
export async function getOrderById(db, tenantId, orderId) {
    return db.prepare(`${ORDER_SELECT_SQL} WHERE tenant_id = ? AND order_id = ? LIMIT 1`).bind(tenantId, orderId).first();
}
/**
 * Monta o statement de leitura canonica por `orderId`.
 *
 * O recheck operacional o usa para reler o agregado dentro do mesmo batch de
 * reconciliacao, sem duplicar aliases ou SQL fora do repositorio.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador do pedido.
 * @returns {D1PreparedStatement} Statement bindado.
 */
export function buildSelectOrderByIdStatement(db, tenantId, orderId) {
    return db.prepare(`${ORDER_SELECT_SQL} WHERE tenant_id = ? AND order_id = ? LIMIT 1`).bind(tenantId, orderId);
}
/**
 * Busca o pedido aberto mais recente de um usuario em um tenant/canal.
 *
 * Esta consulta existe para a borda conversacional do Telegram: quando o mesmo
 * usuario envia um novo update, o runtime precisa retomar o pedido ativo em vez
 * de criar uma duplicata sem contexto. Consideramos "aberto" todo pedido que
 * ainda nao entrou em um passo terminal conhecido.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} userId Usuario do canal atual.
 * @param {string} [channel="telegram"] Canal logico do pedido.
 * @returns {Promise<OrderRecord | null>} Pedido aberto mais recente, se existir.
 */
export async function getLatestOpenOrderByUser(db, tenantId, userId, channel = "telegram") {
    return db.prepare(`${ORDER_SELECT_SQL}
     WHERE tenant_id = ?
       AND user_id = ?
       AND channel = ?
       AND current_step NOT IN (${TERMINAL_ORDER_STEPS.map(() => "?").join(", ")})
     ORDER BY julianday(updated_at) DESC, julianday(created_at) DESC
     LIMIT 1`).bind(tenantId, userId, channel, ...TERMINAL_ORDER_STEPS).first();
}
/**
 * Busca o pedido mais recente de um usuario em um tenant/canal, aberto ou nao.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} userId Usuario do canal atual.
 * @param {string} [channel="telegram"] Canal logico do pedido.
 * @returns {Promise<OrderRecord | null>} Pedido mais recente, se existir.
 */
export async function getLatestOrderByUser(db, tenantId, userId, channel = "telegram") {
    return db.prepare(`${ORDER_SELECT_SQL}
     WHERE tenant_id = ?
       AND user_id = ?
       AND channel = ?
     ORDER BY julianday(updated_at) DESC, julianday(created_at) DESC
     LIMIT 1`).bind(tenantId, userId, channel).first();
}
/**
 * Hidrata o destino de chat Telegram de um pedido legado apenas se ele ainda
 * nao tiver destino persistido.
 *
 * @param {D1Database} db Database D1.
 * @param {HydrateOrderTelegramChatInput} input Identidade do pedido selecionado e chat recebido.
 * @returns {Promise<HydrateOrderTelegramChatResult>} Resultado atomico da tentativa de hidratacao.
 */
export async function hydrateOrderTelegramChatIdIfMissing(db, input) {
    const updatedOrder = await db
        .prepare(`UPDATE orders
       SET telegram_chat_id = ?, updated_at = ?
       WHERE tenant_id = ?
         AND order_id = ?
         AND user_id = ?
         AND channel = ?
         AND telegram_chat_id IS NULL
       RETURNING ${ORDER_COLUMNS_SQL}`)
        .bind(input.telegramChatId, new Date().toISOString(), input.tenantId, input.orderId, input.userId, input.channel)
        .first();
    if (updatedOrder) {
        return {
            order: updatedOrder,
            didUpdate: true,
            notFound: false,
            reason: "updated",
        };
    }
    const currentOrder = await getOrderById(db, input.tenantId, input.orderId);
    return {
        order: currentOrder,
        didUpdate: false,
        notFound: currentOrder === null,
        reason: currentOrder === null ? "not_found" : "already_bound_or_identity_mismatch",
    };
}
/**
 * Atualiza parcialmente um pedido sem permitir colunas fora da whitelist.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador do pedido.
 * @param {OrderPatch} patch Campos permitidos para update.
 * @returns {Promise<OrderRecord | null>} Pedido apos update.
 */
export async function updateOrderById(db, tenantId, orderId, patch) {
    const updateStatement = buildUpdateOrderByIdStatement(db, tenantId, orderId, patch);
    if (!updateStatement) {
        return getOrderById(db, tenantId, orderId);
    }
    const selectStatement = buildSelectOrderByIdStatement(db, tenantId, orderId);
    const [, selectResult] = await db.batch([updateStatement, selectStatement]);
    return selectResult?.results[0] ?? null;
}
/**
 * Monta o statement de update parcial de um pedido.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador do pedido.
 * @param {OrderPatch} patch Campos permitidos para update.
 * @returns {D1PreparedStatement | null} Statement bindado ou `null`.
 */
export function buildUpdateOrderByIdStatement(db, tenantId, orderId, patch) {
    const patchEntries = getAllowedPatchEntries({
        ...patch,
        updatedAt: new Date().toISOString(),
    }, ORDER_UPDATE_COLUMNS);
    if (patchEntries.length === 0) {
        return null;
    }
    // A montagem dinamica do SET acontece apenas em cima de campos ja validados
    // pela whitelist ORDER_UPDATE_COLUMNS.
    const setClause = patchEntries.map(([column]) => `${column} = ?`).join(", ");
    const values = patchEntries.map(([, value]) => value);
    return db.prepare(`UPDATE orders SET ${setClause} WHERE tenant_id = ? AND order_id = ?`).bind(...values, tenantId, orderId);
}
/**
 * Atualiza um pedido somente se ele ainda estiver no passo esperado.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador do pedido.
 * @param {string} expectedCurrentStep Passo que a camada leu antes da transicao.
 * @param {OrderPatch} patch Campos permitidos para update.
 * @returns {Promise<UpdateOrderWithStepGuardResult>} Resultado da escrita protegida por guarda de passo.
 */
export async function updateOrderByIdWithStepGuard(db, tenantId, orderId, expectedCurrentStep, patch) {
    const patchEntries = getAllowedPatchEntries({
        ...patch,
        updatedAt: new Date().toISOString(),
    }, ORDER_UPDATE_COLUMNS);
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
        .prepare(`UPDATE orders
       SET ${setClause}
       WHERE tenant_id = ? AND order_id = ? AND current_step = ?
       RETURNING ${ORDER_COLUMNS_SQL}`)
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
    const currentOrder = await db.prepare(`${ORDER_SELECT_SQL} WHERE tenant_id = ? AND order_id = ? LIMIT 1`).bind(tenantId, orderId).first();
    return {
        order: currentOrder ?? null,
        didUpdate: false,
        conflict: currentOrder !== null,
        notFound: currentOrder === null,
        reason: currentOrder ? "step_conflict" : "not_found",
    };
}
