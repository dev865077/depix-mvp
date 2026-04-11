/**
 * Este arquivo guarda os eventos externos do fluxo financeiro. Separar esse
 * historico em uma tabela propria deixa o sistema mais auditavel e prepara o
 * caminho para webhook e reconciliacao sem perder rastreabilidade.
 */

/**
 * Cria um repositorio para eventos externos.
 * Nesta fundacao, o foco e oferecer o metodo de escrita que futuramente sera
 * usado por webhook, cron de reconciliacao e diagnostico operacional.
 *
 * @param {D1Database} database Binding de banco `D1`.
 * @returns {{recordEvent(input: {orderId?: string | null, depositId?: string | null, qrId?: string | null, source: string, eventType: string, externalStatus?: string | null, payloadJson: string}): Promise<void>}}
 * Repositorio minimo de eventos externos.
 */
export function createExternalEventRepository(database) {
  return {
    /**
     * Persiste um evento bruto recebido de uma integracao externa.
     * Guardar o payload antes do processamento e uma decisao deliberada para
     * apoiar trilha operacional e investigacao de incidentes.
     *
     * @param {{orderId?: string | null, depositId?: string | null, qrId?: string | null, source: string, eventType: string, externalStatus?: string | null, payloadJson: string}} input
     * Dados do evento a registrar.
     * @returns {Promise<void>} Promessa resolvida quando o evento e salvo.
     */
    async recordEvent(input) {
      await database
        .prepare(
          `
            INSERT INTO external_events (
              order_id,
              deposit_id,
              qr_id,
              source,
              event_type,
              external_status,
              payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          input.orderId || null,
          input.depositId || null,
          input.qrId || null,
          input.source,
          input.eventType,
          input.externalStatus || null,
          input.payloadJson,
        )
        .run();
    },
  };
}
