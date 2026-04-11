/**
 * Este arquivo define um logger estruturado bem pequeno para a fundacao do
 * projeto. Ele existe para criar desde cedo o habito de emitir eventos com
 * contexto consistente, sem vazar segredos e sem acoplar a aplicacao a uma
 * solucao de observabilidade mais pesada antes da hora.
 */

const SECRET_LIKE_KEYS = new Set([
  "authorization",
  "token",
  "secret",
  "password",
  "apiKey",
  "api_key",
]);

/**
 * Cria um logger com contexto base compartilhado.
 * A funcao permite que cada request carregue identificadores consistentes em
 * todos os logs emitidos durante o ciclo de vida do handler.
 *
 * @param {Record<string, unknown>} baseContext Campos fixos adicionados a todo log.
 * @returns {{info(message: string, fields?: Record<string, unknown>): void, error(message: string, fields?: Record<string, unknown>): void}}
 * Logger simples com niveis `info` e `error`.
 */
export function createLogger(baseContext) {
  return {
    /**
     * Emite um log informativo com contexto saneado.
     *
     * @param {string} message Nome estavel do evento.
     * @param {Record<string, unknown>} [fields={}] Campos adicionais do log.
     */
    info(message, fields = {}) {
      emitLog("info", message, baseContext, fields);
    },

    /**
     * Emite um log de erro com contexto saneado.
     *
     * @param {string} message Nome estavel do evento.
     * @param {Record<string, unknown>} [fields={}] Campos adicionais do log.
     */
    error(message, fields = {}) {
      emitLog("error", message, baseContext, fields);
    },
  };
}

/**
 * Serializa e envia um evento estruturado para `console`.
 * O runtime da Cloudflare coleta `console.log`, entao esse formato ja serve
 * como trilha operacional minima enquanto o contrato de logs evolui.
 *
 * @param {"info" | "error"} level Nivel do evento.
 * @param {string} message Nome estavel do evento.
 * @param {Record<string, unknown>} baseContext Contexto base compartilhado.
 * @param {Record<string, unknown>} fields Campos adicionais do evento.
 */
function emitLog(level, message, baseContext, fields) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...sanitizeFields(baseContext),
    ...sanitizeFields(fields),
  };

  console.log(JSON.stringify(entry));
}

/**
 * Remove ou mascara campos com cara de segredo antes de ir para log.
 * A protecao aqui e simples, mas ja impede que a fundacao do projeto crie o
 * mau habito de despejar valores sensiveis em texto puro.
 *
 * @param {Record<string, unknown>} fields Campos candidatos a logging.
 * @returns {Record<string, unknown>} Copia segura para emissao.
 */
function sanitizeFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (SECRET_LIKE_KEYS.has(key)) {
        return [key, "[redacted]"];
      }

      return [key, value];
    }),
  );
}
