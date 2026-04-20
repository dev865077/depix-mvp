/**
 * Repositorio de cobrancas Pix/DePix.
 *
 * Este modulo explicita os dois identificadores externos relevantes da Eulen:
 * - `depositEntryId`: `response.id` do `POST /deposit`
 * - `qrId`: identificador usado no webhook e em consultas de reconciliacao
 *
 * Manter ambos no shape de leitura evita que camadas superiores precisem
 * adivinhar se um campo representa a entrada criada ou o QR confirmado.
 */
import { getAllowedPatchEntries } from "../client.js";

/**
 * Nome estavel do indice que materializa a invariavel financeira do MVP.
 *
 * A regra deliberada e mais estrita que "um deposito ativo": enquanto o produto
 * nao tiver refund, split de cobranca ou nova cobranca dentro do mesmo pedido,
 * um pedido local deve apontar para exatamente uma intencao Pix/DePix. Essa
 * constante evita que migration, testes e heuristica de erro passem a falar
 * nomes diferentes para a mesma barreira.
 */
export const DEPOSITS_TENANT_ORDER_UNIQUE_INDEX = "deposits_tenant_order_unique_idx";

/**
 * Erro estruturado para tentativa de criar mais de um deposito no mesmo pedido.
 *
 * O repositorio captura a mensagem bruta do SQLite/D1 e a transforma neste erro
 * de dominio para que services possam tratar retry/concorrencia sem depender de
 * texto especifico do banco. `existingDeposit` e anexado quando a leitura local
 * consegue encontrar a cobranca que venceu a corrida.
 */
export class DepositOrderUniquenessError extends Error {
  /**
   * @param {{ tenantId: string, orderId: string, existingDeposit?: Record<string, unknown> | null, cause?: unknown }} input Contexto seguro.
   */
  constructor(input) {
    super("A deposit already exists for this tenant/order pair.", {
      cause: input.cause,
    });

    this.name = "DepositOrderUniquenessError";
    this.code = "deposit_order_already_has_deposit";
    this.tenantId = input.tenantId;
    this.orderId = input.orderId;
    this.existingDeposit = input.existingDeposit ?? null;
    this.details = {
      tenantId: input.tenantId,
      orderId: input.orderId,
      existingDepositEntryId: input.existingDeposit?.depositEntryId ?? null,
      indexName: DEPOSITS_TENANT_ORDER_UNIQUE_INDEX,
    };
  }
}

/**
 * Reconhece apenas a violacao da barreira `tenant_id + order_id`.
 *
 * Outros indices unicos, como `deposit_entry_id`, `qr_id` e `nonce`, continuam
 * subindo como erro bruto porque representam problemas diferentes de correlacao
 * e nao devem ser mascarados como retry seguro do pedido.
 *
 * @param {unknown} error Erro vindo do D1/SQLite.
 * @returns {boolean} Verdadeiro quando a constraint atingida e a de pedido.
 */
function isDepositOrderUniquenessViolation(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();

  return message.includes(DEPOSITS_TENANT_ORDER_UNIQUE_INDEX)
    || message.includes("deposits.tenant_id, deposits.order_id");
}

const DEPOSIT_SELECT_SQL = `
  SELECT
    tenant_id AS tenantId,
    deposit_entry_id AS depositEntryId,
    qr_id AS qrId,
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
    deposit_entry_id,
    qr_id,
    order_id,
    nonce,
    qr_copy_paste,
    qr_image_url,
    external_status,
    expiration
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const DEPOSIT_UPDATE_COLUMNS = {
  tenantId: "tenant_id",
  qrId: "qr_id",
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
 * `qrId` pode nascer ausente, porque a Eulen primeiro devolve
 * `depositEntryId` no `POST /deposit` e depois expoe `qrId` no status/webhook.
 *
 * @param {Record<string, unknown>} input Payload vindo da camada de servico.
 * @returns {{
 *   tenantId: string,
 *   depositEntryId: string,
 *   qrId: string | null,
 *   orderId: string,
 *   nonce: string,
 *   qrCopyPaste: string,
 *   qrImageUrl: string,
 *   externalStatus: string,
 *   expiration: string | null
 * }} Deposito normalizado.
 */
function normalizeDepositInput(input) {
  return {
    tenantId: String(input.tenantId),
    depositEntryId: String(input.depositEntryId),
    qrId: typeof input.qrId === "string" && input.qrId.trim().length > 0 ? input.qrId.trim() : null,
    orderId: String(input.orderId),
    nonce: String(input.nonce),
    qrCopyPaste: String(input.qrCopyPaste),
    qrImageUrl: String(input.qrImageUrl),
    externalStatus: typeof input.externalStatus === "string" && input.externalStatus.trim().length > 0
      ? input.externalStatus.trim()
      : "pending",
    expiration: typeof input.expiration === "string" && input.expiration.trim().length > 0
      ? input.expiration.trim()
      : null,
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
    deposit.depositEntryId,
    deposit.qrId,
    deposit.orderId,
    deposit.nonce,
    deposit.qrCopyPaste,
    deposit.qrImageUrl,
    deposit.externalStatus,
    deposit.expiration,
  );
  const selectStatement = db.prepare(`${DEPOSIT_SELECT_SQL} WHERE tenant_id = ? AND deposit_entry_id = ? LIMIT 1`).bind(
    deposit.tenantId,
    deposit.depositEntryId,
  );
  try {
    const [, selectResult] = await db.batch([insertStatement, selectStatement]);

    return selectResult.results[0];
  } catch (error) {
    if (isDepositOrderUniquenessViolation(error)) {
      const existingDeposit = await getLatestDepositByOrderId(db, deposit.tenantId, deposit.orderId);

      throw new DepositOrderUniquenessError({
        tenantId: deposit.tenantId,
        orderId: deposit.orderId,
        existingDeposit,
        cause: error,
      });
    }

    throw error;
  }
}

/**
 * Busca um deposito pelo identificador de entrada retornado no create-deposit.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositEntryId ID canonico da entrada criada na Eulen.
 * @returns {Promise<Record<string, unknown> | null>} Deposito encontrado.
 */
export async function getDepositByDepositEntryId(db, tenantId, depositEntryId) {
  return db.prepare(`${DEPOSIT_SELECT_SQL} WHERE tenant_id = ? AND deposit_entry_id = ? LIMIT 1`).bind(
    tenantId,
    depositEntryId,
  ).first();
}

/**
 * Monta o statement de leitura canonica por `depositEntryId`.
 *
 * O service de recheck usa este builder para reler o agregado dentro do mesmo
 * batch de persistencia, mantendo SQL e aliases centralizados no repositorio.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositEntryId ID canonico da entrada criada na Eulen.
 * @returns {import("@cloudflare/workers-types").D1PreparedStatement} Statement bindado.
 */
export function buildSelectDepositByDepositEntryIdStatement(db, tenantId, depositEntryId) {
  return db.prepare(`${DEPOSIT_SELECT_SQL} WHERE tenant_id = ? AND deposit_entry_id = ? LIMIT 1`).bind(
    tenantId,
    depositEntryId,
  );
}

/**
 * Busca um deposito pelo `qrId` usado na reconciliacao externa.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} qrId ID do QR informado pelo webhook ou por consultas remotas.
 * @returns {Promise<Record<string, unknown> | null>} Deposito encontrado.
 */
export async function getDepositByQrId(db, tenantId, qrId) {
  return db.prepare(`${DEPOSIT_SELECT_SQL} WHERE tenant_id = ? AND qr_id = ? LIMIT 1`).bind(tenantId, qrId).first();
}

/**
 * Busca o deposito mais recente associado a um pedido local.
 *
 * O fluxo do Telegram usa esta leitura como ancora de idempotencia depois da
 * confirmacao do usuario. Se um retry ou webhook duplicado chegar apos a
 * cobranca ja ter sido criada, a camada de servico consegue reutilizar o
 * deposito existente sem disparar uma nova chamada externa.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} orderId Identificador local do pedido.
 * @returns {Promise<Record<string, unknown> | null>} Deposito mais recente do pedido, se existir.
 */
export async function getLatestDepositByOrderId(db, tenantId, orderId) {
  return db.prepare(
    `${DEPOSIT_SELECT_SQL}
     WHERE tenant_id = ? AND order_id = ?
     ORDER BY julianday(updated_at) DESC, julianday(created_at) DESC
     LIMIT 1`,
  ).bind(tenantId, orderId).first();
}

/**
 * Lista depositos que ainda precisam de reconciliacao segura de `qrId`.
 *
 * O conjunto inclui:
 * - depositos novos com `qrId` nulo
 * - linhas migradas do schema legado, onde `qrId` ainda replica
 *   `depositEntryId` por falta de correlacao melhor
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @returns {Promise<Record<string, unknown>[]>} Depositos candidatos a reconciliacao.
 */
export async function listDepositsNeedingQrIdReconciliation(db, tenantId) {
  const result = await db.prepare(`${DEPOSIT_SELECT_SQL} WHERE tenant_id = ? AND (qr_id IS NULL OR qr_id = deposit_entry_id) ORDER BY created_at DESC`).bind(
    tenantId,
  ).all();

  return result.results;
}

/**
 * Atualiza parcialmente um deposito usando `depositEntryId` como ancora local.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositEntryId ID canonico da entrada criada na Eulen.
 * @param {Record<string, unknown>} patch Campos permitidos para update.
 * @returns {Promise<Record<string, unknown> | null>} Deposito apos update.
 */
export async function updateDepositByDepositEntryId(db, tenantId, depositEntryId, patch) {
  const updateStatement = buildUpdateDepositByDepositEntryIdStatement(db, tenantId, depositEntryId, patch);

  if (!updateStatement) {
    return getDepositByDepositEntryId(db, tenantId, depositEntryId);
  }

  const selectStatement = buildSelectDepositByDepositEntryIdStatement(db, tenantId, depositEntryId);
  const [, selectResult] = await db.batch([updateStatement, selectStatement]);

  return selectResult.results[0];
}

/**
 * Monta o statement de update parcial de um deposito por `depositEntryId`.
 *
 * O retorno `null` sinaliza que o patch era vazio e evita que camadas mais
 * altas montem SQL dinamico fora do repositorio.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db Database D1.
 * @param {string} tenantId Tenant atual.
 * @param {string} depositEntryId ID canonico da entrada criada na Eulen.
 * @param {Record<string, unknown>} patch Campos permitidos para update.
 * @returns {import("@cloudflare/workers-types").D1PreparedStatement | null} Statement bindado ou `null`.
 */
export function buildUpdateDepositByDepositEntryIdStatement(db, tenantId, depositEntryId, patch) {
  const patchEntries = getAllowedPatchEntries(
    {
      ...patch,
      updatedAt: new Date().toISOString(),
    },
    DEPOSIT_UPDATE_COLUMNS,
  );

  if (patchEntries.length === 0) {
    return null;
  }

  const setClause = patchEntries.map(([column]) => `${column} = ?`).join(", ");
  const values = patchEntries.map(([, value]) => value);
  return db.prepare(`UPDATE deposits SET ${setClause} WHERE tenant_id = ? AND deposit_entry_id = ?`).bind(
    ...values,
    tenantId,
    depositEntryId,
  );
}
