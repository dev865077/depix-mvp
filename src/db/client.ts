/**
 * Cliente de banco do MVP.
 *
 * Este módulo expõe o binding nativo do Cloudflare D1 e um helper mínimo para
 * updates parciais com allowlist explícita de colunas. A intenção aqui é usar
 * a API nativa do runtime sem recriar um ORM.
 */
type DatabaseEnv = {
  DB?: unknown;
} & Record<string, unknown>;

type PatchKey<TPatch extends object> = Extract<keyof TPatch, string>;

export type AllowedPatchColumns<TPatch extends object> = Readonly<Record<PatchKey<TPatch>, string>>;

/**
 * Garante que o binding D1 exista antes de a aplicação acessar o banco.
 *
 * @param {DatabaseEnv} env Bindings recebidos pelo Worker.
 * @returns {D1Database} Binding D1 pronto para uso.
 */
export function assertDatabaseBinding(env: DatabaseEnv): D1Database {
  if (!env.DB) {
    throw new Error("Missing required D1 binding: DB");
  }

  return env.DB as D1Database;
}

/**
 * Devolve o binding D1 nativo do Worker.
 *
 * @param {DatabaseEnv} env Bindings recebidos pelo Worker.
 * @returns {D1Database} Binding D1 pronto para SQL cru.
 */
export function getDatabase(env: DatabaseEnv): D1Database {
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
export function getAllowedPatchEntries<TPatch extends object>(
  patch: Partial<TPatch> | undefined | null,
  allowedColumns: AllowedPatchColumns<TPatch>,
): Array<[string, unknown]> {
  if (!patch) {
    return [];
  }

  const patchEntries = Object.entries(patch) as Array<[PatchKey<TPatch>, TPatch[PatchKey<TPatch>] | undefined]>;

  return patchEntries
    .filter(([key, value]) => value !== undefined && Object.prototype.hasOwnProperty.call(allowedColumns, key))
    .map(([key, value]) => [allowedColumns[key], value]);
}
