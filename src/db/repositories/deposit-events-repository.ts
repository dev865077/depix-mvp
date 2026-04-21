/**
 * Repositorio de historico de eventos externos.
 *
 * Cada evento fica amarrado ao `depositEntryId` local e, quando conhecido,
 * tambem carrega o `qrId` externo que apareceu no webhook ou no recheck.
 * Assim a trilha fica auditavel sem reintroduzir a ambiguidade do antigo
 * `deposit_id`.
 */
import type {
  CreateDepositEventInput,
  DepositEventRecord,
} from "../../types/persistence.js";

const DEPOSIT_EVENT_SELECT_SQL = `
  SELECT
    id AS id,
    tenant_id AS tenantId,
    order_id AS orderId,
    deposit_entry_id AS depositEntryId,
    qr_id AS qrId,
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
    deposit_entry_id,
    qr_id,
    source,
    external_status,
    bank_tx_id,
    blockchain_tx_id,
    raw_payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING
    id AS id,
    tenant_id AS tenantId,
    order_id AS orderId,
    deposit_entry_id AS depositEntryId,
    qr_id AS qrId,
    source AS source,
    external_status AS externalStatus,
    bank_tx_id AS bankTxId,
    blockchain_tx_id AS blockchainTxId,
    raw_payload AS rawPayload,
    received_at AS receivedAt
`;

/**
 * Monta o statement de insert de um evento externo.
 *
 * @param {D1Database} db Database D1.
 * @param {CreateDepositEventInput} input Evento a ser armazenado.
 * @returns {D1PreparedStatement} Statement bindado.
 */
export function buildCreateDepositEventStatement(
  db: D1Database,
  input: CreateDepositEventInput,
): D1PreparedStatement {
  return db.prepare(INSERT_DEPOSIT_EVENT_SQL).bind(
    input.tenantId,
    input.orderId,
    input.depositEntryId,
    input.qrId ?? null,
    input.source,
    input.externalStatus,
    input.bankTxId ?? null,
    input.blockchainTxId ?? null,
    input.rawPayload,
  );
}

/**
 * Persiste um evento externo associado a um deposito.
 *
 * @param {D1Database} db Database D1.
 * @param {CreateDepositEventInput} input Evento a ser armazenado.
 * @returns {Promise<DepositEventRecord | null>} Evento persistido.
 */
export async function createDepositEvent(
  db: D1Database,
  input: CreateDepositEventInput,
): Promise<DepositEventRecord | null> {
  return buildCreateDepositEventStatement(db, input).first<DepositEventRecord>();
}

/**
 * Busca um evento por id dentro do escopo do tenant.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {number} id Identificador numerico do evento.
 * @returns {Promise<DepositEventRecord | undefined | null>} Evento encontrado.
 */
export async function getDepositEventById(
  db: D1Database,
  tenantId: string,
  id: number,
): Promise<DepositEventRecord | undefined | null> {
  if (typeof id !== "number") {
    return undefined;
  }

  return db.prepare(`${DEPOSIT_EVENT_SELECT_SQL} WHERE tenant_id = ? AND id = ? LIMIT 1`).bind(
    tenantId,
    id,
  ).first<DepositEventRecord>();
}

/**
 * Lista o historico de eventos de um deposito em ordem decrescente.
 *
 * @param {D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositEntryId ID canonico da entrada criada na Eulen.
 * @returns {Promise<DepositEventRecord[]>} Eventos do deposito.
 */
export async function listDepositEventsByDepositEntryId(
  db: D1Database,
  tenantId: string,
  depositEntryId: string,
): Promise<DepositEventRecord[]> {
  const result = await db.prepare(
    `${DEPOSIT_EVENT_SELECT_SQL} WHERE tenant_id = ? AND deposit_entry_id = ? ORDER BY id DESC`,
  ).bind(
    tenantId,
    depositEntryId,
  ).all<DepositEventRecord>();

  return result.results;
}
