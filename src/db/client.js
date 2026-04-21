/**
 * Garante que o binding D1 exista antes de a aplicação acessar o banco.
 *
 * @param {DatabaseEnv} env Bindings recebidos pelo Worker.
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
 * @param {DatabaseEnv} env Bindings recebidos pelo Worker.
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
 * @param {Partial<TPatch> | undefined | null} patch Dados parciais recebidos.
 * @param {AllowedPatchColumns<TPatch>} allowedColumns Mapa de campos permitidos.
 * @returns {Array<[string, unknown]>} Pares prontos para compor cláusulas SQL.
 */
export function getAllowedPatchEntries(patch, allowedColumns) {
    if (!patch) {
        return [];
    }
    const patchEntries = Object.entries(patch);
    return patchEntries
        .filter(([key, value]) => value !== undefined && Object.prototype.hasOwnProperty.call(allowedColumns, key))
        .map(([key, value]) => [allowedColumns[key], value]);
}
