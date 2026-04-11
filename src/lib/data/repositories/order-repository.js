/**
 * Este arquivo encapsula o acesso aos pedidos persistidos em `D1`. A ideia e
 * manter SQL e regras de mapeamento em um lugar unico, deixando os futuros
 * services do dominio mais simples de ler e testar.
 */

/**
 * Cria um repositorio de pedidos a partir de uma conexao `D1`.
 * O repositorio oferece apenas as operacoes basicas da `S1`, suficientes para
 * a fundacao do fluxo de pedido e faturamento.
 *
 * @param {D1Database} database Binding de banco `D1`.
 * @returns {{createDraftOrder(input: {orderId: string, channel: string, productType: string, amountInCents: number | null, depixAddress: string | null, conversationState: string, status?: string, nonce?: string | null, telegramChatId?: string | null, telegramUserId?: string | null}): Promise<void>, findOrderById(orderId: string): Promise<Record<string, unknown> | null>, updateOrderConversationData(orderId: string, changes: {amountInCents?: number | null, depixAddress?: string | null, conversationState?: string, status?: string, nonce?: string | null}): Promise<void>}}
 * Conjunto minimo de operacoes de pedido.
 */
export function createOrderRepository(database) {
  return {
    /**
     * Cria um pedido inicial ainda antes da cobranca Pix existir.
     * Isso permite que o MVP tenha um `orderId` estavel desde a coleta dos
     * dados no Telegram ate a integracao com a Eulen.
     *
     * @param {{orderId: string, channel: string, productType: string, amountInCents: number | null, depixAddress: string | null, conversationState: string, status?: string, nonce?: string | null, telegramChatId?: string | null, telegramUserId?: string | null}} input
     * Dados minimos do pedido.
     * @returns {Promise<void>} Promessa resolvida quando o registro e salvo.
     */
    async createDraftOrder(input) {
      await database
        .prepare(
          `
            INSERT INTO orders (
              order_id,
              channel,
              product_type,
              amount_in_cents,
              depix_address,
              conversation_state,
              status,
              nonce,
              telegram_chat_id,
              telegram_user_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          input.orderId,
          input.channel,
          input.productType,
          input.amountInCents,
          input.depixAddress,
          input.conversationState,
          input.status || "draft",
          input.nonce || null,
          input.telegramChatId || null,
          input.telegramUserId || null,
        )
        .run();
    },

    /**
     * Busca um pedido pelo identificador principal do dominio.
     * Essa consulta sera um dos pontos de entrada mais comuns do fluxo.
     *
     * @param {string} orderId Identificador unico do pedido.
     * @returns {Promise<Record<string, unknown> | null>} Pedido encontrado ou `null`.
     */
    async findOrderById(orderId) {
      const result = await database
        .prepare("SELECT * FROM orders WHERE order_id = ? LIMIT 1")
        .bind(orderId)
        .first();

      return result || null;
    },

    /**
     * Atualiza os principais dados de conversa ligados ao pedido.
     * A intencao aqui e permitir que a coleta no Telegram e a persistencia do
     * pedido avancem juntas sem esperar a integracao Pix.
     *
     * @param {string} orderId Identificador do pedido alvo.
     * @param {{amountInCents?: number | null, depixAddress?: string | null, conversationState?: string, status?: string, nonce?: string | null}} changes
     * Campos mutaveis no contexto inicial do pedido.
     * @returns {Promise<void>} Promessa resolvida quando a atualizacao termina.
     */
    async updateOrderConversationData(orderId, changes) {
      await database
        .prepare(
          `
            UPDATE orders
            SET
              amount_in_cents = COALESCE(?, amount_in_cents),
              depix_address = COALESCE(?, depix_address),
              conversation_state = COALESCE(?, conversation_state),
              status = COALESCE(?, status),
              nonce = COALESCE(?, nonce),
              updated_at = CURRENT_TIMESTAMP
            WHERE order_id = ?
          `,
        )
        .bind(
          changes.amountInCents,
          changes.depixAddress,
          changes.conversationState,
          changes.status,
          changes.nonce,
          orderId,
        )
        .run();
    },
  };
}
