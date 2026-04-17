/**
 * Repositorio de cobrancas Pix/DePix.
 *
 * Este modulo persiste a intencao de deposito/cobranca e seus principais
 * atributos de reconciliacao, sempre sob escopo explicito de tenant.
 */
import { getAllowedPatchEntries } from "../client.js";

// Alias em camelCase para manter a API interna do repositorio previsivel.
const DEPOSIT_SELECT_SQL = `
  SELECT
    tenant_id AS tenantId,
    deposit_id AS depositId,
    order_id AS orderId,
    nonce AS nonce,
    qr_copy_paste AS qrCopyPaste,
    qr_image_url AS qrImageUrl,
    external_status AS externalStatus,
    expiration AS expiration,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM deposits
`;

const INSERT_DEPOSIT_SQL = `
  INSERT INTO deposits (
    tenant_id,
    deposit_id,
    order_id,
    nonce,
    qr_copy_paste,
    qr_image_url,
    external_status,
    expiration
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const DEPOSIT_UPDATE_COLUMNS = {
  tenantId: "tenant_id",
  orderId: "order_id",
  nonce: "nonce",
  qrCopyPaste: "qr_copy_paste",
  qrImageUrl: "qr_image_url",
  externalStatus: "external_status",
  expiration: "expiration",
  updatedAt: "updated_at",
};

/**
 * Garante defaults minimos para um deposito novo.
 *
 * @param {Record<string, unknown>} input Payload vindo da camada de servico.
 * @returns {Record<string, unknown>} Deposito normalizado.
 */
function normalizeDepositInput(input) {
  return {
    tenantId: input.tenantId,
    depositId: input.depositId,
    orderId: input.orderId,
    nonce: input.nonce,
    qrCopyPaste: input.qrCopyPaste,
    qrImageUrl: input.qrImageUrl,
    externalStatus: input.externalStatus ?? "pending",
    expiration: input.expiration ?? null,
  };
}

/**
 * Cria o deposito e rele o registro no mesmo batch.
 *
 * Isto preserva o padrao de operacoes criticas recomendado no contexto atual
 * do projeto, alem de devolver ao chamador o formato final persistido.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {Record<string, unknown>} input Dados do deposito.
 * @returns {Promise<Record<string, unknown> | undefined>} Deposito persistido.
 */
export async function createDeposit(db, input) {
  const deposit = normalizeDepositInput(input);
  const insertStatement = db.prepare(INSERT_DEPOSIT_SQL).bind(
    deposit.tenantId,
    deposit.depositId,
    deposit.orderId,
    deposit.nonce,
    deposit.qrCopyPaste,
    deposit.qrImageUrl,
    deposit.externalStatus,
    deposit.expiration,
  );
  const selectStatement = db.prepare(`${DEPOSIT_SELECT_SQL} WHERE tenant_id = ? AND deposit_id = ? LIMIT 1`).bind(
    deposit.tenantId,
    deposit.depositId,
  );
  const [, selectResult] = await db.batch([insertStatement, selectStatement]);

  return selectResult.results[0];
}

/**
 * Busca um deposito pelo identificador externo e tenant.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositId Identificador canonico do deposito.
 * @returns {Promise<Record<string, unknown> | null>} Deposito encontrado.
 */
export async function getDepositById(db, tenantId, depositId) {
  return db.prepare(`${DEPOSIT_SELECT_SQL} WHERE tenant_id = ? AND deposit_id = ? LIMIT 1`).bind(tenantId, depositId).first();
}

/**
 * Atualiza parcialmente um deposito com isolamento por tenant.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositId Identificador canonico do deposito.
 * @param {Record<string, unknown>} patch Campos permitidos para update.
 * @returns {Promise<Record<string, unknown> | null>} Deposito apos update.
 */
export async function updateDepositById(db, tenantId, depositId, patch) {
  const patchEntries = getAllowedPatchEntries(
    {
      ...patch,
      updatedAt: new Date().toISOString(),
    },
    DEPOSIT_UPDATE_COLUMNS,
  );

  if (patchEntries.length === 0) {
    return getDepositById(db, tenantId, depositId);
  }

  // O update dinamico e seguro porque so usamos colunas whitelisted.
  const setClause = patchEntries.map(([column]) => `${column} = ?`).join(", ");
  const values = patchEntries.map(([, value]) => value);
  const updateStatement = db.prepare(`UPDATE deposits SET ${setClause} WHERE tenant_id = ? AND deposit_id = ?`).bind(
    ...values,
    tenantId,
    depositId,
  );
  const selectStatement = db.prepare(`${DEPOSIT_SELECT_SQL} WHERE tenant_id = ? AND deposit_id = ? LIMIT 1`).bind(
    tenantId,
    depositId,
  );
  const [, selectResult] = await db.batch([updateStatement, selectStatement]);

  return selectResult.results[0];
}
