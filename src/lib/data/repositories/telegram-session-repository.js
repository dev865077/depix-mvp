/**
 * Este arquivo encapsula a persistencia das sessoes de conversa do Telegram.
 * Ele existe para que o canal tenha sua propria trilha de contexto sem misturar
 * detalhes de UX conversacional com a tabela principal de pedidos.
 */

/**
 * Cria um repositorio para sessoes do Telegram.
 * As operacoes aqui focam na `S1`, em que precisamos lembrar o estado da
 * conversa e manter um vinculo opcional com o pedido em andamento.
 *
 * @param {D1Database} database Binding de banco `D1`.
 * @returns {{findSessionByChatId(chatId: string): Promise<Record<string, unknown> | null>, upsertSession(input: {chatId: string, telegramUserId?: string | null, state: string, activeOrderId?: string | null, productType?: string | null, amountInCents?: number | null, depixAddress?: string | null}): Promise<void>}}
 * Operacoes minimas para sessao conversacional.
 */
export function createTelegramSessionRepository(database) {
  return {
    /**
     * Busca a sessao ativa de um chat.
     *
     * @param {string} chatId Identificador do chat no Telegram.
     * @returns {Promise<Record<string, unknown> | null>} Sessao ou `null`.
     */
    async findSessionByChatId(chatId) {
      const result = await database
        .prepare("SELECT * FROM telegram_sessions WHERE chat_id = ? LIMIT 1")
        .bind(chatId)
        .first();

      return result || null;
    },

    /**
     * Cria ou atualiza a sessao de conversa do chat.
     * O uso de `ON CONFLICT` simplifica a persistencia do contexto enquanto o
     * fluxo ainda passa por estados lineares e bem controlados.
     *
     * @param {{chatId: string, telegramUserId?: string | null, state: string, activeOrderId?: string | null, productType?: string | null, amountInCents?: number | null, depixAddress?: string | null}} input
     * Dados de contexto da sessao.
     * @returns {Promise<void>} Promessa resolvida quando a sessao e persistida.
     */
    async upsertSession(input) {
      await database
        .prepare(
          `
            INSERT INTO telegram_sessions (
              chat_id,
              telegram_user_id,
              state,
              active_order_id,
              product_type,
              amount_in_cents,
              depix_address
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
              telegram_user_id = excluded.telegram_user_id,
              state = excluded.state,
              active_order_id = excluded.active_order_id,
              product_type = excluded.product_type,
              amount_in_cents = excluded.amount_in_cents,
              depix_address = excluded.depix_address,
              updated_at = CURRENT_TIMESTAMP
          `,
        )
        .bind(
          input.chatId,
          input.telegramUserId || null,
          input.state,
          input.activeOrderId || null,
          input.productType || null,
          input.amountInCents || null,
          input.depixAddress || null,
        )
        .run();
    },
  };
}
