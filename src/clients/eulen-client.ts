/**
 * Client HTTP isolado da Eulen.
 *
 * Este modulo concentra autenticacao, nonce, async mode, timeout e parsing de
 * resposta para os endpoints usados no MVP. Ele existe para separar integracao
 * externa da regra de negocio e explicitar os contratos externos sensiveis.
 */

const REQUIRED_DEPOSIT_SPLIT_FIELDS = [
  "depixSplitAddress",
  "splitFee",
] as const;
const EULEN_ASYNC_RESULT_DEFAULT_MAX_ATTEMPTS = 6;
const EULEN_ASYNC_RESULT_DEFAULT_POLL_DELAY_MS = 1_000;

export type EulenAsyncMode = "auto" | "true" | "false";
export type EulenInvalidPayloadSource = "request" | "response" | "webhook";

export interface EulenRuntimeConfig {
  eulenApiBaseUrl: string;
  eulenApiTimeoutMs: number;
}

export interface EulenCredentials {
  apiToken?: string;
  partnerId?: string;
}

export interface EulenCreateDepositRequest {
  [key: string]: unknown;
  amountInCents: number;
  depixAddress?: string;
  depixSplitAddress: string;
  splitFee: string;
}

export interface EulenCreateDepositResponsePayload {
  [key: string]: unknown;
  id: string;
  qrCopyPaste: string;
  qrImageUrl: string;
  expiration?: string;
}

export interface EulenDepositStatusResponsePayload {
  [key: string]: unknown;
  bankTxId?: string;
  blockchainTxId?: string;
  qrId?: string;
  status?: string;
  expiration?: string;
}

export interface EulenAsyncResponsePointer {
  async: true;
  urlResponse: string;
  expiration?: string;
}

export interface EulenInvalidPayloadDetails {
  [key: string]: unknown;
  code: "eulen_invalid_payload";
  source: EulenInvalidPayloadSource;
  reason: string;
  field?: string;
  requestId?: string;
  path?: string;
  status?: number;
}

export interface EulenApiResponse<TData = unknown> {
  ok: boolean;
  status: number;
  nonce: string;
  asyncMode: EulenAsyncMode;
  headers: Record<string, string>;
  data: TData;
}

export interface EulenAsyncResultData<TPayload> {
  response: TPayload;
  async: false;
  resolvedFromAsync: true;
  originalAsync: EulenAsyncResponsePointer;
  asyncResult: {
    status: number;
    headers: Record<string, string>;
    attempt: number;
  };
}

type EulenApiRequest = {
  path: string;
  method?: string;
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  nonce?: string;
  asyncMode?: string;
};

type EulenAsyncResultOptions = {
  maxAttempts?: number;
  pollDelayMs?: number;
};

type EulenRequestHeaderOptions = {
  apiToken: string;
  partnerId?: string;
  nonce?: string;
  asyncMode?: string;
  contentType?: string;
};

type InvalidPayloadInput = {
  source: EulenInvalidPayloadSource;
  reason: string;
  field?: string;
  requestId?: string;
  path?: string;
  status?: number;
};

/**
 * Erro padronizado para qualquer falha de integracao com a Eulen.
 *
 * O campo `details` ajuda a manter logs ricos sem vazar segredos.
 */
export class EulenApiError extends Error {
  details: Record<string, unknown>;

  /**
   * @param {string} message Mensagem principal do erro.
   * @param {Record<string, unknown>=} details Metadados operacionais.
   */
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EulenApiError";
    this.details = details;
  }
}

/**
 * Erro estruturado para payload invalido na borda Eulen.
 */
export class EulenPayloadValidationError extends EulenApiError {
  declare details: EulenInvalidPayloadDetails;

  constructor(message: string, input: InvalidPayloadInput) {
    super(message, buildInvalidEulenPayloadDetails(input));
    this.name = "EulenPayloadValidationError";
    this.details = buildInvalidEulenPayloadDetails(input);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapEulenResponsePayload(payload: unknown): unknown {
  if (isRecord(payload) && "response" in payload) {
    return payload.response;
  }

  return payload;
}

function hasResolvedResponseEnvelope(payload: unknown): payload is Record<string, unknown> & { response: unknown; async: false } {
  return isRecord(payload) && payload.async === false && "response" in payload;
}

function buildInvalidPayloadError(message: string, input: InvalidPayloadInput): EulenPayloadValidationError {
  return new EulenPayloadValidationError(message, input);
}

function readRequiredTrimmedString(value: unknown, input: InvalidPayloadInput): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw buildInvalidPayloadError("Eulen payload is missing a required text field.", input);
  }

  return value.trim();
}

function readOptionalTrimmedString(value: unknown, input: InvalidPayloadInput): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw buildInvalidPayloadError("Eulen payload contains an invalid text field.", input);
  }

  const normalizedValue = value.trim();

  return normalizedValue.length > 0 ? normalizedValue : undefined;
}

function readRequiredPositiveInteger(value: unknown, input: InvalidPayloadInput): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw buildInvalidPayloadError("Eulen payload is missing a required positive integer field.", input);
  }

  return value;
}

export function buildInvalidEulenPayloadDetails(input: InvalidPayloadInput): EulenInvalidPayloadDetails {
  return {
    code: "eulen_invalid_payload",
    source: input.source,
    reason: input.reason,
    ...(input.field ? { field: input.field } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.path ? { path: input.path } : {}),
    ...(typeof input.status === "number" ? { status: input.status } : {}),
  };
}

/**
 * Garante que o tenant atual trouxe as credenciais minimas da Eulen.
 *
 * @param {{ apiToken?: string, partnerId?: string }} credentials Credenciais resolvidas para o tenant.
 * @returns {{ apiToken: string, partnerId?: string }} Credenciais normalizadas.
 */
export function assertEulenCredentials(credentials: EulenCredentials): { apiToken: string; partnerId?: string } {
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
 * Garante que o payload de create-deposit usado hoje pelo MVP e valido.
 *
 * @param {unknown} body Payload bruto do deposit.
 * @param {string=} requestId Request id opcional para correlacao.
 * @returns {EulenCreateDepositRequest} Payload validado.
 */
export function assertEulenCreateDepositRequest(body: unknown, requestId?: string): EulenCreateDepositRequest {
  if (!isRecord(body)) {
    throw buildInvalidPayloadError("Eulen create-deposit request must be a JSON object.", {
      source: "request",
      reason: "request_body_must_be_object",
      requestId,
      path: "/deposit",
    });
  }

  return {
    amountInCents: readRequiredPositiveInteger(body.amountInCents, {
      source: "request",
      reason: "missing_required_positive_integer",
      field: "amountInCents",
      requestId,
      path: "/deposit",
    }),
    depixAddress: readOptionalTrimmedString(body.depixAddress, {
      source: "request",
      reason: "field_must_be_string",
      field: "depixAddress",
      requestId,
      path: "/deposit",
    }),
    depixSplitAddress: readRequiredTrimmedString(body.depixSplitAddress, {
      source: "request",
      reason: "missing_required_string",
      field: "depixSplitAddress",
      requestId,
      path: "/deposit",
    }),
    splitFee: readRequiredTrimmedString(body.splitFee, {
      source: "request",
      reason: "missing_required_string",
      field: "splitFee",
      requestId,
      path: "/deposit",
    }),
  };
}

/**
 * Alias legada mantida para compatibilidade com testes e callsites antigos.
 *
 * @param {unknown} body Payload bruto do deposit.
 * @returns {EulenCreateDepositRequest} Payload validado.
 */
export function assertRequiredDepositSplit(body: unknown): EulenCreateDepositRequest {
  return assertEulenCreateDepositRequest(body);
}

/**
 * Valida o payload de create-deposit consumido hoje pelo MVP.
 *
 * @param {unknown} payload Corpo bruto recebido da Eulen.
 * @param {string=} requestId Request id opcional para correlacao.
 * @returns {EulenCreateDepositResponsePayload} Payload validado.
 */
export function assertEulenCreateDepositResponsePayload(
  payload: unknown,
  requestId?: string,
): EulenCreateDepositResponsePayload {
  const candidate = unwrapEulenResponsePayload(payload);

  if (!isRecord(candidate)) {
    throw buildInvalidPayloadError("Eulen create-deposit response must be a JSON object.", {
      source: "response",
      reason: "response_body_must_be_object",
      requestId,
      path: "/deposit",
    });
  }

  return {
    id: readRequiredTrimmedString(candidate.id, {
      source: "response",
      reason: "missing_required_string",
      field: "id",
      requestId,
      path: "/deposit",
    }),
    qrCopyPaste: readRequiredTrimmedString(candidate.qrCopyPaste, {
      source: "response",
      reason: "missing_required_string",
      field: "qrCopyPaste",
      requestId,
      path: "/deposit",
    }),
    qrImageUrl: readRequiredTrimmedString(candidate.qrImageUrl, {
      source: "response",
      reason: "missing_required_string",
      field: "qrImageUrl",
      requestId,
      path: "/deposit",
    }),
    expiration: readOptionalTrimmedString(candidate.expiration, {
      source: "response",
      reason: "field_must_be_string",
      field: "expiration",
      requestId,
      path: "/deposit",
    }),
  };
}

/**
 * Valida o payload de deposit-status consumido hoje pelo MVP.
 *
 * @param {unknown} payload Corpo bruto recebido da Eulen.
 * @param {string=} requestId Request id opcional para correlacao.
 * @returns {EulenDepositStatusResponsePayload} Payload validado.
 */
export function assertEulenDepositStatusResponsePayload(
  payload: unknown,
  requestId?: string,
): EulenDepositStatusResponsePayload {
  const candidate = unwrapEulenResponsePayload(payload);

  if (!isRecord(candidate)) {
    throw buildInvalidPayloadError("Eulen deposit-status response must be a JSON object.", {
      source: "response",
      reason: "response_body_must_be_object",
      requestId,
      path: "/deposit-status",
    });
  }

  const normalizedPayload = {
    bankTxId: readOptionalTrimmedString(candidate.bankTxId, {
      source: "response",
      reason: "field_must_be_string",
      field: "bankTxId",
      requestId,
      path: "/deposit-status",
    }),
    blockchainTxId: readOptionalTrimmedString(candidate.blockchainTxID, {
      source: "response",
      reason: "field_must_be_string",
      field: "blockchainTxID",
      requestId,
      path: "/deposit-status",
    }) ?? readOptionalTrimmedString(candidate.blockchainTxId, {
      source: "response",
      reason: "field_must_be_string",
      field: "blockchainTxId",
      requestId,
      path: "/deposit-status",
    }),
    qrId: readOptionalTrimmedString(candidate.qrId, {
      source: "response",
      reason: "field_must_be_string",
      field: "qrId",
      requestId,
      path: "/deposit-status",
    }),
    status: readOptionalTrimmedString(candidate.status, {
      source: "response",
      reason: "field_must_be_string",
      field: "status",
      requestId,
      path: "/deposit-status",
    }),
    expiration: readOptionalTrimmedString(candidate.expiration, {
      source: "response",
      reason: "field_must_be_string",
      field: "expiration",
      requestId,
      path: "/deposit-status",
    }),
  };

  if (
    !normalizedPayload.bankTxId
    && !normalizedPayload.blockchainTxId
    && !normalizedPayload.qrId
    && !normalizedPayload.status
    && !normalizedPayload.expiration
  ) {
    throw buildInvalidPayloadError("Eulen deposit-status response did not expose any supported field.", {
      source: "response",
      reason: "response_missing_supported_fields",
      requestId,
      path: "/deposit-status",
    });
  }

  return normalizedPayload;
}

/**
 * Gera um nonce novo para uma intencao inedita de chamada externa.
 *
 * @returns {string} Nonce UUID.
 */
export function generateNonce(): string {
  return crypto.randomUUID();
}

/**
 * Normaliza o modo aceito pelo header `X-Async`.
 *
 * @param {string | undefined} asyncMode Valor solicitado pela camada chamadora.
 * @returns {"auto" | "true" | "false"} Valor pronto para o header.
 */
export function normalizeAsyncMode(asyncMode: string | undefined): EulenAsyncMode {
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
 * @param {EulenRequestHeaderOptions} options Opcoes da chamada atual.
 * @returns {{ headers: Headers, nonce: string, asyncMode: EulenAsyncMode }} Resultado normalizado.
 */
export function buildEulenRequestHeaders(options: EulenRequestHeaderOptions): { headers: Headers; nonce: string; asyncMode: EulenAsyncMode } {
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
export function buildEulenUrl(baseUrl: string, path: string, query: Record<string, string | undefined> = {}): string {
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
export function createTimeoutController(timeoutMs: number): { controller: AbortController; cleanup: () => void } {
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
export async function parseEulenResponseBody(response: Response): Promise<unknown> {
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
 * @param {number} delayMs Intervalo em milissegundos.
 * @returns {Promise<void>} Promessa resolvida apos o intervalo.
 */
function waitForEulenAsyncResultRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Verifica se o corpo retornado pela Eulen e um ponteiro de resultado async.
 *
 * @param {unknown} data Corpo parseado da resposta inicial.
 * @returns {data is EulenAsyncResponsePointer} Verdadeiro quando ha resultado async pendente.
 */
export function isEulenAsyncResponsePointer(data: unknown): data is EulenAsyncResponsePointer {
  return Boolean(
    isRecord(data)
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
function normalizeEulenAsyncResultOptions(options: EulenAsyncResultOptions = {}): { maxAttempts: number; pollDelayMs: number } {
  const maxAttemptsInput = options.maxAttempts;
  const pollDelayInput = options.pollDelayMs;
  const maxAttempts = typeof maxAttemptsInput === "number" && Number.isInteger(maxAttemptsInput) && maxAttemptsInput > 0
    ? maxAttemptsInput
    : EULEN_ASYNC_RESULT_DEFAULT_MAX_ATTEMPTS;
  const pollDelayMs = typeof pollDelayInput === "number" && Number.isInteger(pollDelayInput) && pollDelayInput >= 0
    ? pollDelayInput
    : EULEN_ASYNC_RESULT_DEFAULT_POLL_DELAY_MS;

  return { maxAttempts, pollDelayMs };
}

/**
 * Le a URL de resultado assincrono publicada pela Eulen.
 *
 * @param {{ urlResponse: string, expiration?: string }} pointer Ponteiro retornado pela Eulen.
 * @param {{ maxAttempts?: number, pollDelayMs?: number }=} options Politica de polling.
 * @returns {Promise<{ status: number, headers: Record<string, string>, attempt: number, data: unknown }>} Resultado publicado.
 */
export async function readEulenAsyncResult(
  pointer: { urlResponse: string; expiration?: string },
  options: EulenAsyncResultOptions = {},
): Promise<{ status: number; headers: Record<string, string>; attempt: number; data: unknown }> {
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
 * @param {unknown} asyncResultData Corpo retornado pela URL async.
 * @returns {unknown} Payload final da operacao Eulen.
 */
function normalizeEulenAsyncResultPayload(asyncResultData: unknown): unknown {
  return unwrapEulenResponsePayload(asyncResultData);
}

/**
 * Resolve respostas Eulen que foram aceitas para execucao assincrona.
 *
 * @param {EulenApiResponse<unknown>} response Resposta inicial da Eulen.
 * @param {{ maxAttempts?: number, pollDelayMs?: number }=} options Politica de polling da URL async.
 * @returns {Promise<EulenApiResponse<unknown> | EulenApiResponse<EulenAsyncResultData<unknown>>>} Resposta original ou resposta resolvida.
 */
export async function resolveEulenAsyncResponse(
  response: EulenApiResponse<unknown>,
  options: EulenAsyncResultOptions = {},
): Promise<EulenApiResponse<unknown> | EulenApiResponse<EulenAsyncResultData<unknown>>> {
  if (!isEulenAsyncResponsePointer(response.data)) {
    return response;
  }

  const asyncResult = await readEulenAsyncResult(response.data, options);
  const responsePayload = normalizeEulenAsyncResultPayload(asyncResult.data);

  if (
    isRecord(responsePayload)
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
 * Resolve create-deposit para um envelope canonico com payload validado.
 *
 * @param {EulenApiResponse<unknown>} response Resposta inicial da Eulen.
 * @param {{ maxAttempts?: number, pollDelayMs?: number }=} options Politica async opcional.
 * @param {string=} requestId Request id opcional para correlacao.
 * @returns {Promise<EulenApiResponse<{ response: EulenCreateDepositResponsePayload, async: false, resolvedFromAsync?: true, originalAsync?: EulenAsyncResponsePointer, asyncResult?: { status: number, headers: Record<string, string>, attempt: number } }>>} Envelope canonico validado.
 */
export async function resolveCreatedEulenDepositResponse(
  response: EulenApiResponse<unknown>,
  options: EulenAsyncResultOptions = {},
  requestId?: string,
): Promise<EulenApiResponse<{
  response: EulenCreateDepositResponsePayload;
  async: false;
  resolvedFromAsync?: true;
  originalAsync?: EulenAsyncResponsePointer;
  asyncResult?: {
    status: number;
    headers: Record<string, string>;
    attempt: number;
  };
}>> {
  const resolvedResponse = await resolveEulenAsyncResponse(response, options);

  if (hasResolvedResponseEnvelope(resolvedResponse.data)) {
    return {
      ...resolvedResponse,
      data: {
        ...resolvedResponse.data,
        response: assertEulenCreateDepositResponsePayload(resolvedResponse.data.response, requestId),
      },
    };
  }

  return {
    ...resolvedResponse,
    data: {
      response: assertEulenCreateDepositResponsePayload(resolvedResponse.data, requestId),
      async: false,
    },
  };
}

/**
 * Resolve deposit-status para o shape canonico consumido hoje pelo MVP.
 *
 * @param {EulenApiResponse<unknown>} response Resposta inicial da Eulen.
 * @param {{ maxAttempts?: number, pollDelayMs?: number }=} options Politica async opcional.
 * @param {string=} requestId Request id opcional para correlacao.
 * @returns {Promise<EulenDepositStatusResponsePayload>} Status remoto validado.
 */
export async function resolveEulenDepositStatusResponse(
  response: EulenApiResponse<unknown>,
  options: EulenAsyncResultOptions = {},
  requestId?: string,
): Promise<EulenDepositStatusResponsePayload> {
  const resolvedResponse = await resolveEulenAsyncResponse(response, options);

  return assertEulenDepositStatusResponsePayload(resolvedResponse.data, requestId);
}

/**
 * Executa uma chamada padronizada para a Eulen no contexto de um tenant.
 *
 * @param {{ eulenApiBaseUrl: string, eulenApiTimeoutMs: number }} runtimeConfig Configuracao segura do runtime.
 * @param {{ apiToken?: string, partnerId?: string }} credentials Credenciais resolvidas do tenant.
 * @param {EulenApiRequest} request Configuracao da chamada atual.
 * @returns {Promise<EulenApiResponse<unknown>>} Resposta normalizada da integracao.
 */
export async function requestEulenApi(
  runtimeConfig: EulenRuntimeConfig,
  credentials: EulenCredentials,
  request: EulenApiRequest,
): Promise<EulenApiResponse<unknown>> {
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
 * @returns {Promise<EulenApiResponse<unknown>>} Resposta padronizada.
 */
export function pingEulen(
  runtimeConfig: EulenRuntimeConfig,
  credentials: EulenCredentials,
  options: { nonce?: string; asyncMode?: string } = {},
): Promise<EulenApiResponse<unknown>> {
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
 * @param {{ body: unknown, nonce?: string, asyncMode?: string, requestId?: string }} options Opcoes da chamada.
 * @returns {Promise<EulenApiResponse<unknown>>} Resposta padronizada.
 */
export function createEulenDeposit(
  runtimeConfig: EulenRuntimeConfig,
  credentials: EulenCredentials,
  options: { body: unknown; nonce?: string; asyncMode?: string; requestId?: string },
): Promise<EulenApiResponse<unknown>> {
  return requestEulenApi(runtimeConfig, credentials, {
    path: "/deposit",
    method: "POST",
    body: { ...assertEulenCreateDepositRequest(options.body, options.requestId) },
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
 * @returns {Promise<EulenApiResponse<unknown>>} Resposta padronizada.
 */
export function getEulenDepositStatus(
  runtimeConfig: EulenRuntimeConfig,
  credentials: EulenCredentials,
  options: { id: string; nonce?: string; asyncMode?: string },
): Promise<EulenApiResponse<unknown>> {
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
 * @returns {Promise<EulenApiResponse<unknown>>} Resposta padronizada.
 */
export function listEulenDeposits(
  runtimeConfig: EulenRuntimeConfig,
  credentials: EulenCredentials,
  options: { start: string; end: string; status?: string; nonce?: string; asyncMode?: string },
): Promise<EulenApiResponse<unknown>> {
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
