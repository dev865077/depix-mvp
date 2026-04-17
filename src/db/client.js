/**
 * Cliente de banco do MVP.
 *
 * Este módulo expõe o binding nativo do Cloudflare D1 e um helper mínimo para
 * updates parciais com allowlist explícita de colunas. A intenção aqui é usar
 * a API nativa do runtime sem recriar um ORM.
 */

/**
 * Garante que o binding D1 exista antes de a aplicação acessar o banco.
 *
 * @param {Record<string, unknown>} env Bindings recebidos pelo Worker.
 * @returns {D1Database} Binding D1 pronto para uso.
 */
export function assertDatabaseBinding(env) {
  if (!env.DB) {
    throw new Error("Missing required D1 binding: DB");
  }

  return env.DB;
}

/**
 * Devolve o binding D1 nativo do Worker.
 *
 * @param {Record<string, unknown>} env Bindings recebidos pelo Worker.
 * @returns {D1Database} Binding D1 pronto para SQL cru.
 */
export function getDatabase(env) {
  return assertDatabaseBinding(env);
}

/**
 * Filtra um patch parcial usando uma allowlist explícita de colunas.
 *
 * Convenção do projeto:
 * - banco usa `snake_case`
 * - a aplicação usa `camelCase`
 * - updates recebem chaves em `camelCase` e este helper converte apenas o que
 *   estiver permitido no mapa `camelCase -> snake_case`
 *
 * @param {Record<string, unknown> | undefined | null} patch Dados parciais recebidos.
 * @param {Record<string, string>} allowedColumns Mapa de campos permitidos.
 * @returns {Array<[string, unknown]>} Pares prontos para compor cláusulas SQL.
 */
export function getAllowedPatchEntries(patch, allowedColumns) {
  if (!patch) {
    return [];
  }

  return Object.entries(patch).filter(
    ([key, value]) => value !== undefined && Object.prototype.hasOwnProperty.call(allowedColumns, key),
  ).map(([key, value]) => [allowedColumns[key], value]);
}
