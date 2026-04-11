/**
 * Este arquivo implementa o fluxo inicial da conversa de compra. Ele traduz
 * entradas do usuario em mudancas de estado previsiveis, permitindo que o
 * futuro adaptador do Telegram delegue o raciocinio da jornada para um modulo
 * proprio e testavel. O caminho aqui cobre o basico da `S1`.
 */

import {
  CONVERSATION_STATES,
  createInitialConversationContext,
  isConversationTransitionAllowed,
} from "./conversation-states.js";

const SUPPORTED_PRODUCT = "depix";
const MINIMUM_AMOUNT_IN_CENTS = 100;

/**
 * Avanca a conversa um passo com base no estado atual e na entrada do usuario.
 * A funcao existe para encapsular a maquina de conversa num formato puro, sem
 * depender de HTTP, Telegram ou banco de dados para tomar decisoes.
 *
 * @param {{state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null} | null | undefined} context
 * Contexto atual da sessao.
 * @param {string} userInput Texto recebido do usuario.
 * @returns {{context: {state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null}, prompt: string, accepted: boolean, validationError: string | null}}
 * Resultado da tentativa de avancar a jornada.
 */
export function advanceConversation(context, userInput) {
  const currentContext = context || createInitialConversationContext();
  const normalizedInput = normalizeUserInput(userInput);

  if (
    currentContext.state === CONVERSATION_STATES.IDLE &&
    isStartIntent(normalizedInput)
  ) {
    return transitionConversation(currentContext, {
      nextState: CONVERSATION_STATES.WAITING_PRODUCT,
      prompt:
        "Produto disponivel no MVP: DePix. Responda com 'depix' para continuar.",
    });
  }

  if (currentContext.state === CONVERSATION_STATES.WAITING_PRODUCT) {
    if (normalizedInput !== SUPPORTED_PRODUCT) {
      return rejectConversationStep(
        currentContext,
        "Apenas o produto 'depix' esta no escopo do MVP atual.",
      );
    }

    return transitionConversation(
      {
        ...currentContext,
        productType: SUPPORTED_PRODUCT,
      },
      {
        nextState: CONVERSATION_STATES.WAITING_AMOUNT,
        prompt:
          "Informe o valor em reais. Exemplos validos: 50 ou 50,90.",
      },
    );
  }

  if (currentContext.state === CONVERSATION_STATES.WAITING_AMOUNT) {
    const amountInCents = parseAmountInCents(normalizedInput);

    if (!amountInCents || amountInCents < MINIMUM_AMOUNT_IN_CENTS) {
      return rejectConversationStep(
        currentContext,
        "Valor invalido. Informe pelo menos R$ 1,00 usando numeros.",
      );
    }

    return transitionConversation(
      {
        ...currentContext,
        amountInCents,
      },
      {
        nextState: CONVERSATION_STATES.WAITING_DEPIX_ADDRESS,
        prompt:
          "Agora envie a carteira ou endereco DePix que recebera a entrega.",
      },
    );
  }

  if (currentContext.state === CONVERSATION_STATES.WAITING_DEPIX_ADDRESS) {
    if (!isValidDepixAddress(normalizedInput)) {
      return rejectConversationStep(
        currentContext,
        "Endereco DePix invalido. Envie um valor nao vazio com pelo menos 8 caracteres.",
      );
    }

    return transitionConversation(
      {
        ...currentContext,
        depixAddress: normalizedInput,
      },
      {
        nextState: CONVERSATION_STATES.READY_TO_CREATE_ORDER,
        prompt: buildReviewPrompt({
          productType: currentContext.productType || SUPPORTED_PRODUCT,
          amountInCents: currentContext.amountInCents,
          depixAddress: normalizedInput,
        }),
      },
    );
  }

  if (currentContext.state === CONVERSATION_STATES.READY_TO_CREATE_ORDER) {
    return {
      context: currentContext,
      prompt:
        "Dados minimos coletados. O proximo passo e persistir o pedido e criar a cobranca Pix.",
      accepted: true,
      validationError: null,
    };
  }

  return rejectConversationStep(
    currentContext,
    "Envie 'start' para comecar a jornada do MVP.",
  );
}

/**
 * Cria uma resposta de rejeicao sem avancar o estado da conversa.
 * Ela preserva o contexto existente e devolve um erro de validacao claro para
 * o adaptador do canal exibir ao usuario.
 *
 * @param {{state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null}} context
 * Contexto atual preservado.
 * @param {string} validationError Mensagem de validacao para o usuario.
 * @returns {{context: {state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null}, prompt: string, accepted: boolean, validationError: string}}
 * Resultado negativo do passo atual.
 */
function rejectConversationStep(context, validationError) {
  return {
    context,
    prompt: validationError,
    accepted: false,
    validationError,
  };
}

/**
 * Aplica uma transicao valida de estado e devolve o proximo prompt.
 * A funcao cria uma barreira unica para impedir mudancas de estado invalidas
 * durante a evolucao da jornada.
 *
 * @param {{state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null}} context
 * Contexto base da conversa.
 * @param {{nextState: string, prompt: string}} transition Dados da transicao desejada.
 * @returns {{context: {state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null}, prompt: string, accepted: boolean, validationError: null}}
 * Resultado positivo da mudanca de estado.
 */
function transitionConversation(context, transition) {
  if (!isConversationTransitionAllowed(context.state, transition.nextState)) {
    throw new Error(
      `Invalid conversation transition from '${context.state}' to '${transition.nextState}'.`,
    );
  }

  return {
    context: {
      ...context,
      state: transition.nextState,
    },
    prompt: transition.prompt,
    accepted: true,
    validationError: null,
  };
}

/**
 * Normaliza texto livre recebido do usuario.
 * A padronizacao reduz variacao boba de entrada e simplifica o tratamento das
 * escolhas basicas do fluxo.
 *
 * @param {string} userInput Texto original informado pelo usuario.
 * @returns {string} Texto limpo em lowercase e sem espacos nas pontas.
 */
function normalizeUserInput(userInput) {
  return String(userInput || "").trim().toLowerCase();
}

/**
 * Detecta as intencoes mais simples de inicio da conversa.
 * A funcao existe para o fluxo aceitar comandos comuns sem depender de um
 * parser mais sofisticado nesta fase do projeto.
 *
 * @param {string} normalizedInput Entrada ja normalizada.
 * @returns {boolean} `true` quando a conversa deve ser iniciada.
 */
function isStartIntent(normalizedInput) {
  return ["start", "/start", "oi", "ola", "comprar"].includes(normalizedInput);
}

/**
 * Converte uma entrada textual em centavos.
 * O parser cobre o basico do mercado local, aceitando ponto ou virgula como
 * separador decimal para reduzir atrito no Telegram.
 *
 * @param {string} normalizedInput Valor informado pelo usuario.
 * @returns {number | null} Valor em centavos ou `null` quando invalido.
 */
function parseAmountInCents(normalizedInput) {
  const normalizedAmount = normalizedInput.replace(/\./g, "").replace(",", ".");
  const amount = Number(normalizedAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return Math.round(amount * 100);
}

/**
 * Faz uma validacao inicial bem simples do endereco DePix.
 * Nesta fase, queremos barrar apenas entradas obviamente vazias ou curtas,
 * deixando validacoes mais profundas para quando o contrato definitivo estiver
 * mais claro na camada de integracao.
 *
 * @param {string} normalizedInput Texto normalizado do endereco.
 * @returns {boolean} `true` quando o valor passa na validacao minima.
 */
function isValidDepixAddress(normalizedInput) {
  return normalizedInput.length >= 8;
}

/**
 * Monta um resumo amigavel dos dados coletados.
 * Esse resumo prepara o proximo passo da `S1`, em que o pedido sera salvo no
 * banco antes da criacao da cobranca.
 *
 * @param {{productType: string, amountInCents: number | null, depixAddress: string}} params
 * Dados coletados na jornada.
 * @returns {string} Mensagem de revisao pronta para o canal.
 */
function buildReviewPrompt(params) {
  const amountInReais = ((params.amountInCents || 0) / 100).toFixed(2);

  return [
    "Dados coletados com sucesso:",
    `- produto: ${params.productType}`,
    `- valor: R$ ${amountInReais}`,
    `- carteira DePix: ${params.depixAddress}`,
    "Proximo passo: persistir o pedido e criar a cobranca Pix.",
  ].join("\n");
}
