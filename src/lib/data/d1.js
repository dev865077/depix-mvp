/**
 * Este arquivo concentra o acesso ao binding de `D1`. Ele existe para evitar
 * que a aplicacao espalhe suposicoes sobre o nome do binding pelo codigo e
 * para deixar claro desde cedo como o projeto detecta se o banco esta pronto.
 */

const DATABASE_BINDING_NAME = "DB";

/**
 * Verifica se o ambiente possui o binding esperado de `D1`.
 * Isso nos permite expor readiness e falhas de configuracao de forma simples
 * antes mesmo de conectar as historias posteriores da integracao financeira.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @returns {boolean} `true` quando o binding `DB` existe.
 */
export function hasDatabaseBinding(env) {
  return Boolean(env && env[DATABASE_BINDING_NAME]);
}

/**
 * Recupera o binding de `D1` do ambiente.
 * A funcao devolve `null` quando o binding ainda nao esta configurado, o que
 * e util para endpoints de diagnostico e bootstrap.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @returns {D1Database | null} Banco configurado ou `null`.
 */
export function getDatabaseBinding(env) {
  return hasDatabaseBinding(env) ? /** @type {D1Database} */ (env.DB) : null;
}

/**
 * Exige a presenca do binding `D1` antes de operar.
 * Esse helper sera usado nos repositorios reais para falhar de forma clara em
 * vez de deixar erros mais opacos aparecerem tardiamente.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @returns {D1Database} Instancia do banco configurado.
 */
export function requireDatabaseBinding(env) {
  const database = getDatabaseBinding(env);

  if (!database) {
    throw new Error(
      "Missing D1 binding 'DB'. Configure the database before using repositories.",
    );
  }

  return database;
}
