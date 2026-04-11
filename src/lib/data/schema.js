/**
 * Este arquivo documenta a estrutura inicial de dados do MVP. Ele nao executa
 * migracoes por conta propria; seu papel e tornar o schema compreensivel no
 * proprio codigo e apontar para o SQL versionado em `migrations/`.
 */

const TABLES = Object.freeze({
  ORDERS: "orders",
  TELEGRAM_SESSIONS: "telegram_sessions",
  EXTERNAL_EVENTS: "external_events",
});

const INDEXES = Object.freeze([
  "idx_orders_status",
  "idx_orders_nonce",
  "idx_orders_deposit_id",
  "idx_telegram_sessions_state",
  "idx_external_events_order_id",
  "idx_external_events_deposit_id",
]);

/**
 * Devolve uma visao resumida do schema inicial.
 * Esse resumo alimenta endpoints de diagnostico e tambem funciona como
 * documentacao executavel para futuras IAs e devs.
 *
 * @returns {{tables: typeof TABLES, indexes: readonly string[], purpose: string}}
 * Metadados principais da persistencia inicial.
 */
export function getSchemaOverview() {
  return {
    tables: TABLES,
    indexes: INDEXES,
    purpose:
      "Persistir pedidos, sessoes de conversa do Telegram e eventos externos do fluxo financeiro.",
  };
}

export { INDEXES, TABLES };
