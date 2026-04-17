/**
 * Repositorio de historico de eventos externos.
 *
 * A tabela `deposit_events` registra a trilha bruta dos callbacks e rechecks
 * associados a um deposito. Ela e essencial para auditoria, idempotencia e
 * comparacao entre a verdade recebida por webhook e a verdade reconsultada.
 */
const DEPOSIT_EVENT_SELECT_SQL = `
  SELECT
    id AS id,
    tenant_id AS tenantId,
    order_id AS orderId,
    deposit_id AS depositId,
    source AS source,
    external_status AS externalStatus,
    bank_tx_id AS bankTxId,
    blockchain_tx_id AS blockchainTxId,
    raw_payload AS rawPayload,
    received_at AS receivedAt
  FROM deposit_events
`;

const INSERT_DEPOSIT_EVENT_SQL = `
  INSERT INTO deposit_events (
    tenant_id,
    order_id,
    deposit_id,
    source,
    external_status,
    bank_tx_id,
    blockchain_tx_id,
    raw_payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING
    id AS id,
    tenant_id AS tenantId,
    order_id AS orderId,
    deposit_id AS depositId,
    source AS source,
    external_status AS externalStatus,
    bank_tx_id AS bankTxId,
    blockchain_tx_id AS blockchainTxId,
    raw_payload AS rawPayload,
    received_at AS receivedAt
`;

/**
 * Persiste um evento externo associado a um deposito.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {Record<string, unknown>} input Evento a ser armazenado.
 * @returns {Promise<Record<string, unknown> | null>} Evento persistido.
 */
export async function createDepositEvent(db, input) {
  return db.prepare(INSERT_DEPOSIT_EVENT_SQL).bind(
    input.tenantId,
    input.orderId,
    input.depositId,
    input.source,
    input.externalStatus,
    input.bankTxId ?? null,
    input.blockchainTxId ?? null,
    input.rawPayload,
  ).first();
}

/**
 * Busca um evento por id dentro do escopo do tenant.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {number} id Identificador numerico do evento.
 * @returns {Promise<Record<string, unknown> | undefined | null>} Evento encontrado.
 */
export async function getDepositEventById(db, tenantId, id) {
  if (typeof id !== "number") {
    return undefined;
  }

  return db.prepare(`${DEPOSIT_EVENT_SELECT_SQL} WHERE tenant_id = ? AND id = ? LIMIT 1`).bind(tenantId, id).first();
}

/**
 * Lista o historico de eventos de um deposito em ordem decrescente.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositId Identificador canonico do deposito.
 * @returns {Promise<Record<string, unknown>[]>} Eventos do deposito.
 */
export async function listDepositEventsByDepositId(db, tenantId, depositId) {
  const result = await db.prepare(`${DEPOSIT_EVENT_SELECT_SQL} WHERE tenant_id = ? AND deposit_id = ? ORDER BY id DESC`).bind(
    tenantId,
    depositId,
  ).all();

  return result.results;
}
