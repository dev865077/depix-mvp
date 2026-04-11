/**
 * Este arquivo centraliza os estados e as transicoes da conversa do Telegram.
 * Ele existe para separar claramente a maquina de conversa do transporte do
 * canal, o que ajuda o projeto a crescer sem espalhar strings de estado por
 * handlers e repositorios. O racional desta base esta em
 * `docs/ARCHITECTURE-FOUNDATION.md`.
 */

/**
 * Enumera os estados basicos da conversa previstos para a `S1`.
 * A lista privilegia o caminho `DePix-first` e deixa espaco para evoluir a
 * jornada sem quebrar os identificadores ja persistidos.
 */
export const CONVERSATION_STATES = Object.freeze({
  IDLE: "idle",
  WAITING_PRODUCT: "waiting_product",
  WAITING_AMOUNT: "waiting_amount",
  WAITING_DEPIX_ADDRESS: "waiting_depix_address",
  READY_TO_CREATE_ORDER: "ready_to_create_order",
});

/**
 * Define as transicoes permitidas entre os estados de conversa.
 * Esse mapa funciona como documentacao executavel e reduz o risco de o fluxo
 * seguir por combinacoes que nao fazem sentido para o MVP.
 */
export const CONVERSATION_TRANSITIONS = Object.freeze({
  [CONVERSATION_STATES.IDLE]: [CONVERSATION_STATES.WAITING_PRODUCT],
  [CONVERSATION_STATES.WAITING_PRODUCT]: [CONVERSATION_STATES.WAITING_AMOUNT],
  [CONVERSATION_STATES.WAITING_AMOUNT]: [
    CONVERSATION_STATES.WAITING_DEPIX_ADDRESS,
  ],
  [CONVERSATION_STATES.WAITING_DEPIX_ADDRESS]: [
    CONVERSATION_STATES.READY_TO_CREATE_ORDER,
  ],
  [CONVERSATION_STATES.READY_TO_CREATE_ORDER]: [
    CONVERSATION_STATES.WAITING_PRODUCT,
  ],
});

/**
 * Informa se uma mudanca de estado e permitida.
 * A funcao sera reaproveitada quando a conversa passar a ser persistida em D1
 * e quando o adaptador real do Telegram comecar a receber updates.
 *
 * @param {string} currentState Estado atual da conversa.
 * @param {string} nextState Proximo estado pretendido.
 * @returns {boolean} `true` quando a transicao e permitida.
 */
export function isConversationTransitionAllowed(currentState, nextState) {
  const allowedNextStates = CONVERSATION_TRANSITIONS[currentState] || [];

  return allowedNextStates.includes(nextState);
}

/**
 * Cria o estado inicial padrao para uma nova sessao de conversa.
 * Esse helper evita repeticao e deixa explicito qual e o ponto de entrada do
 * usuario quando a jornada comeca do zero.
 *
 * @returns {{state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null}}
 * Contexto minimo inicial da conversa.
 */
export function createInitialConversationContext() {
  return {
    state: CONVERSATION_STATES.IDLE,
    productType: null,
    amountInCents: null,
    depixAddress: null,
  };
}
