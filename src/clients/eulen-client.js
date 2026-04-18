/**
 * Client HTTP isolado da Eulen.
 *
 * Este modulo concentra autenticacao, nonce, async mode, timeout e parsing de
 * resposta para os endpoints usados no MVP. Ele existe para separar integracao
 * externa da regra de negocio.
 */

const REQUIRED_DEPOSIT_SPLIT_FIELDS = [
  "depixSplitAddress",
  "splitFee",
];
const EULEN_ASYNC_RESULT_DEFAULT_MAX_ATTEMPTS = 6;
const EULEN_ASYNC_RESULT_DEFAULT_POLL_DELAY_MS = 1_000;

/**
 * Erro padronizado para qualquer falha de integracao com a Eulen.
 *
 * O campo `details` ajuda a manter logs ricos sem vazar segredos.
 */
export class EulenApiError extends Error {
  /**
   * @param {string} message Mensagem principal do erro.
   * @param {Record<string, unknown>=} details Metadados operacionais.
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "EulenApiError";
    this.details = details;
  }
}

/**
 * Garante que o tenant atual trouxe as credenciais minimas da Eulen.
 *
 * @param {{ apiToken?: string, partnerId?: string }} credentials Credenciais resolvidas para o tenant.
 * @returns {{ apiToken: string, partnerId?: string }} Credenciais normalizadas.
 */
export function assertEulenCredentials(credentials) {
  if (!credentials.apiToken || String(credentials.apiToken).trim().length === 0) {
    throw new EulenApiError("Missing required Eulen API token.", {
      field: "apiToken",
    });
  }

  return {
    apiToken: String(credentials.apiToken),
    partnerId: credentials.partnerId ? String(credentials.partnerId) : undefined,
  };
}

/**
 * Garante que a cobranca saia com o split obrigatorio do MVP.
 *
 * @param {Record<string, unknown> | undefined} body Payload bruto do deposit.
 * @returns {Record<string, unknown>} Payload validado.
 */
export function assertRequiredDepositSplit(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EulenApiError("Missing required deposit payload.", {
      field: "body",
    });
  }

  for (const field of REQUIRED_DEPOSIT_SPLIT_FIELDS) {
    const value = body[field];

    if (typeof value !== "string" || value.trim().length === 0) {
      throw new EulenApiError("Missing required deposit split configuration.", {
        field,
      });
    }
  }

  return body;
}

/**
 * Gera um nonce novo para uma intencao inedita de chamada externa.
 *
 * @returns {string} Nonce UUID.
 */
export function generateNonce() {
  return crypto.randomUUID();
}

/**
 * Normaliza o modo aceito pelo header `X-Async`.
 *
 * @param {string | undefined} asyncMode Valor solicitado pela camada chamadora.
 * @returns {"auto" | "true" | "false"} Valor pronto para o header.
 */
export function normalizeAsyncMode(asyncMode) {
  if (asyncMode === undefined || asyncMode === null || asyncMode === "") {
    return "auto";
  }

  const normalizedValue = String(asyncMode).toLowerCase();

  if (normalizedValue !== "auto" && normalizedValue !== "true" && normalizedValue !== "false") {
    throw new EulenApiError("Invalid Eulen async mode.", {
      asyncMode,
    });
  }

  return normalizedValue;
}

/**
 * Monta os headers padrao da Eulen para o tenant atual.
 *
 * O `partnerId` e opcional porque algumas operacoes podem usar conta
 * compartilhada, mas quando existir ele deve seguir junto do tenant resolvido.
 *
 * @param {{
 *   apiToken: string,
 *   partnerId?: string,
 *   nonce?: string,
 *   asyncMode?: string,
 *   contentType?: string
 * }} options Opcoes da chamada atual.
 * @returns {{ headers: Headers, nonce: string, asyncMode: "auto" | "true" | "false" }} Resultado normalizado.
 */
export function buildEulenRequestHeaders(options) {
  const nonce = options.nonce ?? generateNonce();
  const asyncMode = normalizeAsyncMode(options.asyncMode);
  const headers = new Headers({
    Authorization: `Bearer ${options.apiToken}`,
    "X-Nonce": nonce,
    "X-Async": asyncMode,
  });

  if (options.partnerId) {
    headers.set("X-Partner-Id", options.partnerId);
  }

  if (options.contentType) {
    headers.set("Content-Type", options.contentType);
  }

  return { headers, nonce, asyncMode };
}

/**
 * Construi a URL final para o endpoint da Eulen.
 *
 * @param {string} baseUrl Base URL da API.
 * @param {string} path Caminho do endpoint.
 * @param {Record<string, string | undefined>=} query Query string opcional.
 * @returns {string} URL pronta para `fetch`.
 */
export function buildEulenUrl(baseUrl, path, query = {}) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, normalizedBaseUrl);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

/**
 * Cria um AbortController com timeout padrao para chamadas externas.
 *
 * @param {number} timeoutMs Tempo maximo em milissegundos.
 * @returns {{ controller: AbortController, cleanup: () => void }} Controller e rotina de limpeza.
 */
export function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("Eulen request timeout"), timeoutMs);

  return {
    controller,
    cleanup() {
      clearTimeout(timeoutId);
    },
  };
}

/**
 * Faz o parsing do corpo da resposta sem assumir JSON valido em todos os casos.
 *
 * @param {Response} response Resposta HTTP da Eulen.
 * @returns {Promise<unknown>} Corpo parseado.
 */
export async function parseEulenResponseBody(response) {
  const rawBody = await response.text();

  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

/**
 * Aguarda entre leituras de resultado assincrono.
 *
 * A espera fica isolada no client para que testes consigam zerar o intervalo
 * sem alterar o contrato operacional usado pelo Worker em ambiente real.
 *
 * @param {number} delayMs Intervalo em milissegundos.
 * @returns {Promise<void>} Promessa resolvida apos o intervalo.
 */
function waitForEulenAsyncResultRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Verifica se o corpo retornado pela Eulen e um ponteiro de resultado async.
 *
 * A Eulen pode responder `202 Accepted` com `async: true` e uma `urlResponse`
 * publica. Essa URL nao recebe Authorization nem headers do tenant; ela aponta
 * para o resultado materializado pela propria Eulen depois que a operacao
 * terminar. O client trata esse shape como contrato de transporte, nao como
 * regra de negocio da rota de diagnostico.
 *
 * @param {unknown} data Corpo parseado da resposta inicial.
 * @returns {data is { async: true, urlResponse: string, expiration?: string }} Verdadeiro quando ha resultado async pendente.
 */
export function isEulenAsyncResponsePointer(data) {
  return Boolean(
    data
      && typeof data === "object"
      && data.async === true
      && typeof data.urlResponse === "string"
      && data.urlResponse.trim().length > 0,
  );
}

/**
 * Normaliza opcoes de polling para a URL de resultado assincrono da Eulen.
 *
 * @param {{ maxAttempts?: number, pollDelayMs?: number }=} options Opcoes brutas.
 * @returns {{ maxAttempts: number, pollDelayMs: number }} Opcoes seguras.
 */
function normalizeEulenAsyncResultOptions(options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : EULEN_ASYNC_RESULT_DEFAULT_MAX_ATTEMPTS;
  const pollDelayMs = Number.isInteger(options.pollDelayMs) && options.pollDelayMs >= 0
    ? options.pollDelayMs
    : EULEN_ASYNC_RESULT_DEFAULT_POLL_DELAY_MS;

  return { maxAttempts, pollDelayMs };
}

/**
 * Le a URL de resultado assincrono publicada pela Eulen.
 *
 * A URL pode retornar `404` por alguns instantes enquanto o resultado ainda
 * nao foi gravado no blob da Eulen. Por isso o client faz polling curto,
 * limitado e documentado. Qualquer status diferente de `404` encerra a
 * tentativa imediatamente, porque ja representa falha real de transporte.
 *
 * @param {{ urlResponse: string, expiration?: string }} pointer Ponteiro retornado pela Eulen.
 * @param {{ maxAttempts?: number, pollDelayMs?: number }=} options Politica de polling.
 * @returns {Promise<{ status: number, headers: Record<string, string>, attempt: number, data: unknown }>} Resultado publicado.
 */
export async function readEulenAsyncResult(pointer, options = {}) {
  const { maxAttempts, pollDelayMs } = normalizeEulenAsyncResultOptions(options);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(pointer.urlResponse, {
      method: "GET",
    });
    const data = await parseEulenResponseBody(response);

    if (response.ok) {
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        attempt,
        data,
      };
    }

    if (response.status !== 404 || attempt === maxAttempts) {
      throw new EulenApiError("Eulen asynchronous result request failed.", {
        code: "eulen_async_result_unavailable",
        status: response.status,
        attempt,
        maxAttempts,
        expiration: pointer.expiration,
        data,
      });
    }

    await waitForEulenAsyncResultRetry(pollDelayMs);
  }

  throw new EulenApiError("Eulen asynchronous result request timed out.", {
    code: "eulen_async_result_timeout",
    maxAttempts,
    expiration: pointer.expiration,
  });
}

/**
 * Converte o corpo publicado na URL async para payload de negocio.
 *
 * Em respostas sincronas, nosso client preserva o envelope `data.response`.
 * Ja a URL de resultado async da Eulen pode publicar diretamente o payload
 * final ou repetir um envelope semelhante. Esta funcao reduz os dois formatos
 * para o mesmo contrato consumido pelas camadas superiores.
 *
 * @param {unknown} asyncResultData Corpo retornado pela URL async.
 * @returns {unknown} Payload final da operacao Eulen.
 */
function normalizeEulenAsyncResultPayload(asyncResultData) {
  if (
    asyncResultData
    && typeof asyncResultData === "object"
    && "response" in asyncResultData
  ) {
    return asyncResultData.response;
  }

  return asyncResultData;
}

/**
 * Resolve respostas Eulen que foram aceitas para execucao assincrona.
 *
 * O metodo e deliberadamente generico: recebe a resposta normalizada de
 * qualquer endpoint Eulen e so faz trabalho extra quando `data` e um ponteiro
 * async. Assim, rotas de diagnostico e fluxos de produto podem compartilhar o
 * mesmo comportamento sem duplicar polling, parsing ou mapeamento de erro.
 *
 * @template T
 * @param {T & {
 *   status: number,
 *   nonce: string,
 *   asyncMode: "auto" | "true" | "false",
 *   data: unknown
 * }} response Resposta inicial da Eulen.
 * @param {{ maxAttempts?: number, pollDelayMs?: number }=} options Politica de polling da URL async.
 * @returns {Promise<T & {
 *   data: {
 *     response: unknown,
 *     async: false,
 *     resolvedFromAsync: true,
 *     originalAsync: { async: true, urlResponse: string, expiration?: string },
 *     asyncResult: { status: number, headers: Record<string, string>, attempt: number }
 *   }
 * } | T>} Resposta original ou resposta resolvida para payload final.
 */
export async function resolveEulenAsyncResponse(response, options = {}) {
  if (!isEulenAsyncResponsePointer(response.data)) {
    return response;
  }

  const asyncResult = await readEulenAsyncResult(response.data, options);
  const responsePayload = normalizeEulenAsyncResultPayload(asyncResult.data);

  if (
    responsePayload
    && typeof responsePayload === "object"
    && typeof responsePayload.errorMessage === "string"
  ) {
    throw new EulenApiError("Eulen asynchronous API result failed.", {
      code: "eulen_async_result_failed",
      nonce: response.nonce,
      asyncMode: response.asyncMode,
      status: response.status,
      errorMessage: responsePayload.errorMessage,
      expiration: response.data.expiration,
      asyncResultStatus: asyncResult.status,
      asyncResultAttempt: asyncResult.attempt,
    });
  }

  return {
    ...response,
    data: {
      response: responsePayload,
      async: false,
      resolvedFromAsync: true,
      originalAsync: response.data,
      asyncResult: {
        status: asyncResult.status,
        headers: asyncResult.headers,
        attempt: asyncResult.attempt,
      },
    },
  };
}

/**
 * Executa uma chamada padronizada para a Eulen no contexto de um tenant.
 *
 * @param {{ eulenApiBaseUrl: string, eulenApiTimeoutMs: number }} runtimeConfig Configuracao segura do runtime.
 * @param {{ apiToken?: string, partnerId?: string }} credentials Credenciais resolvidas do tenant.
 * @param {{
 *   path: string,
 *   method?: string,
 *   query?: Record<string, string | undefined>,
 *   body?: Record<string, unknown>,
 *   nonce?: string,
 *   asyncMode?: string
 * }} request Configuracao da chamada atual.
 * @returns {Promise<{
 *   ok: boolean,
 *   status: number,
 *   nonce: string,
 *   asyncMode: "auto" | "true" | "false",
 *   headers: Record<string, string>,
 *   data: unknown
 * }>} Resposta normalizada da integracao.
 */
export async function requestEulenApi(runtimeConfig, credentials, request) {
  const normalizedCredentials = assertEulenCredentials(credentials);
  const { headers, nonce, asyncMode } = buildEulenRequestHeaders({
    apiToken: normalizedCredentials.apiToken,
    partnerId: normalizedCredentials.partnerId,
    nonce: request.nonce,
    asyncMode: request.asyncMode,
    contentType: request.body ? "application/json" : undefined,
  });
  const url = buildEulenUrl(runtimeConfig.eulenApiBaseUrl, request.path, request.query);
  const timeoutMs = runtimeConfig.eulenApiTimeoutMs;
  const { controller, cleanup } = createTimeoutController(timeoutMs);

  try {
    const response = await fetch(url, {
      method: request.method ?? "GET",
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
    });
    const data = await parseEulenResponseBody(response);

    if (!response.ok) {
      throw new EulenApiError("Eulen API request failed.", {
        status: response.status,
        nonce,
        path: request.path,
        data,
      });
    }

    return {
      ok: response.ok,
      status: response.status,
      nonce,
      asyncMode,
      headers: Object.fromEntries(response.headers.entries()),
      data,
    };
  } catch (error) {
    if (error instanceof EulenApiError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new EulenApiError("Eulen API request timed out.", {
        nonce,
        path: request.path,
        timeoutMs,
      });
    }

    throw new EulenApiError("Unexpected Eulen API error.", {
      nonce,
      path: request.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    cleanup();
  }
}

/**
 * Ping de conectividade e autenticacao basica da Eulen.
 *
 * @param {{ eulenApiBaseUrl: string, eulenApiTimeoutMs: number }} runtimeConfig Configuracao do runtime.
 * @param {{ apiToken?: string, partnerId?: string }} credentials Credenciais do tenant.
 * @param {{ nonce?: string, asyncMode?: string }=} options Opcoes da chamada.
 * @returns {Promise<ReturnType<typeof requestEulenApi>>} Resposta padronizada.
 */
export function pingEulen(runtimeConfig, credentials, options = {}) {
  return requestEulenApi(runtimeConfig, credentials, {
    path: "/ping",
    method: "GET",
    nonce: options.nonce,
    asyncMode: options.asyncMode,
  });
}

/**
 * Cria uma cobranca Pix -> DePix usando a conta correta do tenant.
 *
 * @param {{ eulenApiBaseUrl: string, eulenApiTimeoutMs: number }} runtimeConfig Configuracao do runtime.
 * @param {{ apiToken?: string, partnerId?: string }} credentials Credenciais do tenant.
 * @param {{ body: Record<string, unknown>, nonce?: string, asyncMode?: string }} options Opcoes da chamada.
 * @returns {Promise<ReturnType<typeof requestEulenApi>>} Resposta padronizada.
 */
export function createEulenDeposit(runtimeConfig, credentials, options) {
  return requestEulenApi(runtimeConfig, credentials, {
    path: "/deposit",
    method: "POST",
    body: assertRequiredDepositSplit(options.body),
    nonce: options.nonce,
    asyncMode: options.asyncMode,
  });
}

/**
 * Consulta o status de um deposito especifico.
 *
 * @param {{ eulenApiBaseUrl: string, eulenApiTimeoutMs: number }} runtimeConfig Configuracao do runtime.
 * @param {{ apiToken?: string, partnerId?: string }} credentials Credenciais do tenant.
 * @param {{ id: string, nonce?: string, asyncMode?: string }} options Opcoes da chamada.
 * @returns {Promise<ReturnType<typeof requestEulenApi>>} Resposta padronizada.
 */
export function getEulenDepositStatus(runtimeConfig, credentials, options) {
  return requestEulenApi(runtimeConfig, credentials, {
    path: "/deposit-status",
    method: "GET",
    query: {
      id: options.id,
    },
    nonce: options.nonce,
    asyncMode: options.asyncMode,
  });
}

/**
 * Lista depositos por janela para reconciliacao e fallback.
 *
 * @param {{ eulenApiBaseUrl: string, eulenApiTimeoutMs: number }} runtimeConfig Configuracao do runtime.
 * @param {{ apiToken?: string, partnerId?: string }} credentials Credenciais do tenant.
 * @param {{ start: string, end: string, status?: string, nonce?: string, asyncMode?: string }} options Opcoes da chamada.
 * @returns {Promise<ReturnType<typeof requestEulenApi>>} Resposta padronizada.
 */
export function listEulenDeposits(runtimeConfig, credentials, options) {
  return requestEulenApi(runtimeConfig, credentials, {
    path: "/deposits",
    method: "GET",
    query: {
      start: options.start,
      end: options.end,
      status: options.status,
    },
    nonce: options.nonce,
    asyncMode: options.asyncMode,
  });
}
