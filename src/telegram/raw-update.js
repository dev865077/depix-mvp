/**
 * Leitura auxiliar do payload bruto do Telegram.
 *
 * O grammY entrega `chat.id` ja convertido pelo parser JSON padrao. Isso e
 * suficiente para a maioria dos fluxos interativos, mas nao e uma boa fonte de
 * verdade para persistencia: IDs do Telegram sao identificadores externos e
 * podem ultrapassar o intervalo seguro de inteiros do JavaScript. Para o campo
 * `orders.telegram_chat_id`, preservamos o lexema original usando
 * `lossless-json`, uma biblioteca pequena e focada em parsing JSON sem perda
 * numerica.
 */
import { isInteger, isLosslessNumber, parse } from "lossless-json";

/**
 * Normaliza um valor de identificador vindo do parser sem perda.
 *
 * @param {unknown} value Valor bruto extraido do update parseado.
 * @returns {string | undefined} Identificador preservado como texto.
 */
function normalizeRawTelegramIdentifier(value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }

  if (isLosslessNumber(value) && isInteger(value)) {
    return value.toString();
  }

  return undefined;
}

/**
 * Extrai o `chat.id` bruto de um update Telegram preservando numeros grandes.
 *
 * A ordem acompanha as superficies que o runtime ja reconhece para resposta:
 * mensagens normais, edicoes, posts de canal, mensagens de business e callback
 * queries. Quando o payload e invalido ou nao possui chat enderecavel, a funcao
 * devolve `undefined` e a camada conversacional decide se deve falhar fechado
 * ou apenas registrar update sem resposta.
 *
 * @param {string} rawBody Corpo JSON original do webhook.
 * @returns {{ chatId?: string, parseFailed: boolean }} Metadados seguros do update.
 */
export function extractTelegramRawUpdateMetadata(rawBody) {
  let update;

  if (!rawBody.includes("\"chat\"") || !rawBody.includes("\"id\"")) {
    return {
      chatId: undefined,
      parseFailed: false,
    };
  }

  try {
    update = parse(rawBody);
  } catch {
    return {
      chatId: undefined,
      parseFailed: true,
    };
  }

  return {
    chatId: normalizeRawTelegramIdentifier(
      update?.message?.chat?.id
        ?? update?.edited_message?.chat?.id
        ?? update?.channel_post?.chat?.id
        ?? update?.edited_channel_post?.chat?.id
        ?? update?.business_message?.chat?.id
        ?? update?.edited_business_message?.chat?.id
        ?? update?.callback_query?.message?.chat?.id,
    ),
    parseFailed: false,
  };
}
