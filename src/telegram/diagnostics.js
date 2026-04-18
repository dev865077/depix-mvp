/**
 * Utilitarios de observabilidade do runtime Telegram.
 *
 * Esta camada concentra a reducao de payloads e updates em metadados pequenos,
 * deterministas e seguros para log. O objetivo e permitir rastreabilidade sem
 * despejar corpo completo de mensagem, token ou payload sensivel.
 */

/**
 * Descobre o tipo principal de um update do Telegram.
 *
 * @param {Record<string, unknown>} update Update bruto recebido do Telegram.
 * @returns {string} Tipo principal do update.
 */
export function detectTelegramUpdateType(update) {
  const updateType = Object.keys(update).find((key) => key !== "update_id");

  return updateType ?? "unknown";
}

/**
 * Monta um resumo seguro do update atual.
 *
 * O resumo evita copiar a mensagem inteira para os logs. Em vez disso, ele
 * preserva apenas o que ajuda suporte e depuracao: ids, tipo do update e
 * sinais simples sobre o conteudo.
 *
 * @param {Record<string, unknown>} update Update bruto do Telegram.
 * @returns {{
 *   updateId: number | undefined,
 *   updateType: string,
 *   chatId: number | string | undefined,
 *   fromId: number | undefined,
 *   hasText: boolean,
 *   textLength: number | undefined,
 *   command: string | undefined
 * }} Resumo reduzido para logs e tratamento de erro.
 */
export function summarizeTelegramUpdate(update) {
  const updateType = detectTelegramUpdateType(update);
  const message = extractTelegramMessage(update);
  const text = typeof message?.text === "string" ? message.text : undefined;
  const command = typeof text === "string" && text.startsWith("/")
    ? text.split(/\s+/u)[0]
    : undefined;

  return {
    updateId: typeof update?.update_id === "number" ? update.update_id : undefined,
    updateType,
    chatId: message?.chat?.id,
    fromId: typeof message?.from?.id === "number" ? message.from.id : undefined,
    hasText: typeof text === "string",
    textLength: typeof text === "string" ? text.length : undefined,
    command,
  };
}

/**
 * Resume o payload de uma chamada outbound para a Bot API.
 *
 * O payload completo nao deve ir para log. Aqui mantemos so as propriedades
 * necessarias para entender qual metodo foi chamado e para qual chat.
 *
 * @param {string} method Metodo chamado na Bot API.
 * @param {Record<string, unknown> | undefined} payload Payload enviado.
 * @returns {{
 *   method: string,
 *   chatId: number | string | undefined,
 *   hasText: boolean,
 *   textLength: number | undefined,
 *   payloadKeys: string[]
 * }} Resumo seguro da chamada outbound.
 */
export function summarizeTelegramApiPayload(method, payload) {
  const text = typeof payload?.text === "string" ? payload.text : undefined;

  return {
    method,
    chatId: payload?.chat_id,
    hasText: typeof text === "string",
    textLength: typeof text === "string" ? text.length : undefined,
    payloadKeys: Object.keys(payload ?? {}).sort(),
  };
}

/**
 * Extrai a mensagem principal do update quando ela existir.
 *
 * @param {Record<string, unknown>} update Update bruto.
 * @returns {any} Mensagem principal ou `undefined`.
 */
function extractTelegramMessage(update) {
  if (updateTypeHasMessage(update?.message)) {
    return update.message;
  }

  if (updateTypeHasMessage(update?.edited_message)) {
    return update.edited_message;
  }

  if (updateTypeHasMessage(update?.channel_post)) {
    return update.channel_post;
  }

  if (updateTypeHasMessage(update?.edited_channel_post)) {
    return update.edited_channel_post;
  }

  return undefined;
}

/**
 * Indica se o valor parece uma mensagem do Telegram.
 *
 * @param {unknown} value Valor bruto a validar.
 * @returns {value is Record<string, any>} Valor tratado como mensagem.
 */
function updateTypeHasMessage(value) {
  return Boolean(value && typeof value === "object");
}
