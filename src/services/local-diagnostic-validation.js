/**
 * Servicos de diagnostico local para validacao de integracoes externas.
 *
 * Este modulo concentra a logica operacional usada para validar Telegram e
 * Eulen durante investigacoes controladas, mantendo a borda HTTP livre de
 * detalhes de integracao, persistencia e tratamento fino de erro.
 *
 * Regras operacionais deste service:
 * - so pode rodar quando o desenvolvimento local habilitar explicitamente
 *   `ENABLE_LOCAL_DIAGNOSTICS=true`
 * - toda entrada deve ser validada antes de acionar efeitos colaterais
 * - todo erro deve ser mapeado para um codigo estavel e detalhes rastreaveis
 */
import {
  createEulenDeposit,
  EulenApiError,
  pingEulen,
  resolveEulenAsyncResponse,
} from "../clients/eulen-client.js";
import { readTenantSecret, readTenantSplitConfig } from "../config/tenants.js";
import { createDeposit } from "../db/repositories/deposits-repository.js";
import { createOrder } from "../db/repositories/orders-repository.js";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const ALLOWED_EULEN_ASYNC_MODES = new Set(["auto", "true", "false"]);
const DIAGNOSTIC_PLACEHOLDER_MARKERS = [
  "replace-with-",
  "split-address-",
  "placeholder",
];
const SUPPORTED_SPLIT_ADDRESS_KINDS = new Set([
  "documented-depix",
  "liquid-confidential",
]);

/**
 * Erro padronizado para diagnosticos locais.
 *
 * O objetivo e permitir que a rota apenas traduza o erro para JSON sem
 * precisar entender a origem detalhada de cada falha.
 */
export class DiagnosticServiceError extends Error {
  /**
   * @param {number} status Status HTTP desejado para a borda.
   * @param {string} code Codigo estavel do erro.
   * @param {string} message Mensagem principal para o operador.
   * @param {Record<string, unknown>=} details Metadados adicionais.
   */
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "DiagnosticServiceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Garante que os diagnosticos locais foram habilitados explicitamente.
 *
 * Este gate usa uma flag de desenvolvimento local carregada por `.dev.vars`
 * ou `.dev.vars.<env>`, que nao sobe para deploy e nao depende de heuristica
 * sobre headers ou URLs reescritas pelo preview remoto.
 *
 * @param {string | undefined} enableLocalDiagnostics Valor bruto do binding.
 * @returns {void}
 */
export function assertLocalDiagnosticsEnabled(enableLocalDiagnostics) {
  if (String(enableLocalDiagnostics).toLowerCase() === "true") {
    return;
  }

  throw new DiagnosticServiceError(
    404,
    "diagnostic_route_unavailable",
    "This diagnostic route is only available when local diagnostics are explicitly enabled in development.",
  );
}

/**
 * Faz o parse seguro de um corpo JSON opcional.
 *
 * @param {string} rawBody Corpo textual bruto.
 * @returns {Record<string, unknown>} Corpo parseado ou objeto vazio.
 */
export function parseDiagnosticJsonBody(rawBody) {
  if (!rawBody || rawBody.trim().length === 0) {
    return {};
  }

  try {
    const parsedBody = JSON.parse(rawBody);

    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new DiagnosticServiceError(400, "invalid_json_body", "The request body must be a JSON object.");
    }

    return parsedBody;
  } catch (error) {
    if (error instanceof DiagnosticServiceError) {
      throw error;
    }

    throw new DiagnosticServiceError(400, "invalid_json_body", "The request body must be valid JSON.");
  }
}

/**
 * Normaliza uma URL base publica recebida do operador.
 *
 * @param {string | undefined} baseUrl URL base bruta.
 * @returns {string | undefined} URL final sem barra final.
 */
export function normalizeDiagnosticPublicBaseUrl(baseUrl) {
  if (!baseUrl) {
    return undefined;
  }

  try {
    return new URL(baseUrl).toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/**
 * Valida e devolve `amountInCents`.
 *
 * @param {Record<string, unknown>} body Corpo JSON parseado.
 * @returns {number} Valor inteiro positivo.
 */
export function readDiagnosticAmountInCents(body) {
  const rawAmount = body.amountInCents;
  const amountInCents = rawAmount === undefined ? 100 : Number.parseInt(String(rawAmount), 10);

  if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
    throw new DiagnosticServiceError(400, "invalid_amount_in_cents", "amountInCents must be a positive integer.");
  }

  return amountInCents;
}

/**
 * Valida e normaliza `asyncMode`.
 *
 * @param {string | undefined} queryAsyncMode Valor vindo da query string.
 * @param {Record<string, unknown>=} body Corpo JSON opcional.
 * @param {"auto" | "true" | "false"=} defaultAsyncMode Default operacional quando a chamada nao informa valor.
 * @returns {"auto" | "true" | "false"} Valor pronto para a integracao.
 */
export function readDiagnosticAsyncMode(queryAsyncMode, body = {}, defaultAsyncMode = "auto") {
  const rawAsyncMode = queryAsyncMode ?? body.asyncMode ?? defaultAsyncMode;
  const normalizedAsyncMode = String(rawAsyncMode).toLowerCase();

  if (!ALLOWED_EULEN_ASYNC_MODES.has(normalizedAsyncMode)) {
    throw new DiagnosticServiceError(400, "invalid_async_mode", "asyncMode must be one of auto, true or false.");
  }

  return /** @type {"auto" | "true" | "false"} */ (normalizedAsyncMode);
}

/**
 * Le um segredo do tenant e converte falhas de binding para erro estruturado.
 *
 * Os diagnosticos operacionais precisam dizer claramente qual segredo faltou
 * e em qual binding o runtime tentou buscá-lo. Isso reduz ambiguidade quando
 * o problema esta em Secrets Store, preview local ou configuracao por tenant.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {{ tenantId: string, secretBindings: Record<string, string> }} tenant Tenant atual.
 * @param {string} secretKey Chave logica do segredo necessario.
 * @returns {Promise<string>} Valor materializado do segredo.
 */
async function readRequiredDiagnosticTenantSecret(env, tenant, secretKey) {
  const bindingName = tenant.secretBindings?.[secretKey];

  try {
    return await readTenantSecret(env, tenant, secretKey);
  } catch (error) {
    throw new DiagnosticServiceError(
      500,
      "diagnostic_secret_unavailable",
      `The diagnostic route could not resolve the tenant secret ${secretKey}.`,
      {
        tenantId: tenant.tenantId,
        secretKey,
        bindingName,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/**
 * Le a configuracao real de split do tenant e converte falhas em erro rastreavel.
 *
 * Split address e split fee ficam em Secrets Store por serem dados financeiros
 * operacionais. Se algum binding estiver ausente, o diagnostico deve parar
 * antes de chamar a Eulen e indicar exatamente quais bindings eram esperados.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {{ tenantId: string, splitConfigBindings: { depixSplitAddress: string, splitFee: string } }} tenant Tenant atual.
 * @returns {Promise<{ depixSplitAddress: string, splitFee: string }>} Split materializado.
 */
async function readRequiredDiagnosticTenantSplitConfig(env, tenant) {
  try {
    return await readTenantSplitConfig(env, tenant);
  } catch (error) {
    throw new DiagnosticServiceError(
      500,
      "diagnostic_split_config_unavailable",
      "The diagnostic route could not resolve the tenant split configuration.",
      {
        tenantId: tenant.tenantId,
        splitConfigBindings: tenant.splitConfigBindings,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/**
 * Identifica valores claramente deixados como placeholder operacional.
 *
 * @param {unknown} value Valor bruto da configuracao.
 * @returns {boolean} Verdadeiro quando o valor nao parece pronto para chamada real.
 */
function isDiagnosticPlaceholderValue(value) {
  if (typeof value !== "string") {
    return true;
  }

  const normalizedValue = value.trim().toLowerCase();

  return normalizedValue.length === 0
    || DIAGNOSTIC_PLACEHOLDER_MARKERS.some((marker) => normalizedValue.includes(marker));
}

/**
 * Monta um relatorio de prontidao do split antes da chamada real.
 *
 * Manter este shape separado da excecao ajuda a testar e evoluir a politica
 * de validacao sem misturar leitura de segredo, regra de negocio e HTTP.
 *
 * @param {{ depixSplitAddress: string, splitFee: string }} splitConfig Split materializado.
 * @returns {{
 *   ready: boolean,
 *   depixSplitAddressLooksPlaceholder: boolean,
 *   splitFeeLooksPlaceholder: boolean,
 *   depixSplitAddressKind: string,
 *   splitFeeLooksPercent: boolean
 * }} Relatorio.
 */
function createSplitConfigReadinessReport(splitConfig) {
  const depixSplitAddressLooksPlaceholder = isDiagnosticPlaceholderValue(splitConfig?.depixSplitAddress);
  const splitFeeLooksPlaceholder = isDiagnosticPlaceholderValue(splitConfig?.splitFee);
  const depixSplitAddressKind = typeof splitConfig?.depixSplitAddress === "string"
    ? classifyDiagnosticSplitAddress(splitConfig.depixSplitAddress)
    : "unknown";
  const splitFee = typeof splitConfig?.splitFee === "string" ? splitConfig.splitFee.trim() : "";
  const splitFeeLooksPercent = /^\d+(?:\.\d{1,2})%$/.test(splitFee);

  return {
    ready: !depixSplitAddressLooksPlaceholder
      && !splitFeeLooksPlaceholder
      && SUPPORTED_SPLIT_ADDRESS_KINDS.has(depixSplitAddressKind)
      && splitFeeLooksPercent,
    depixSplitAddressLooksPlaceholder,
    splitFeeLooksPlaceholder,
    depixSplitAddressKind,
    splitFeeLooksPercent,
  };
}

/**
 * Garante que a configuracao de split do tenant esta pronta para chamada real.
 *
 * O contrato do MVP exige split em toda cobranca. O diagnostico deve parar
 * antes da Eulen quando detectar secret ausente, vazio, claramente fake ou
 * incompatível com os formatos aceitos pelo fluxo operacional. SideSwap gera
 * enderecos Liquid confidenciais (`lq1...`) para recebimento; eles sao
 * aceitos junto do formato `ex1...` visto na documentacao da Eulen.
 *
 * @param {string} tenantId Tenant atual.
 * @param {{ depixSplitAddress: string, splitFee: string }} splitConfig Split materializado.
 * @returns {void}
 */
function assertDiagnosticSplitConfigReady(tenantId, splitConfig) {
  const readiness = createSplitConfigReadinessReport(splitConfig);

  if (readiness.ready) {
    return;
  }

  throw new DiagnosticServiceError(
    500,
    "diagnostic_split_config_not_ready",
    "The tenant split configuration is not ready for a real Eulen deposit call.",
    {
      tenantId,
      depixSplitAddressLooksPlaceholder: readiness.depixSplitAddressLooksPlaceholder,
      splitFeeLooksPlaceholder: readiness.splitFeeLooksPlaceholder,
      depixSplitAddressKind: readiness.depixSplitAddressKind,
      splitFeeLooksPercent: readiness.splitFeeLooksPercent,
    },
  );
}

/**
 * Monta o payload Eulen para create-deposit a partir de entradas ja validadas.
 *
 * A rota nunca aceita split vindo do operador. O split sempre vem da
 * configuracao sensivel do tenant, materializada logo antes da chamada externa.
 *
 * @param {number} amountInCents Valor inteiro em centavos.
 * @param {{ depixSplitAddress: string, splitFee: string }} splitConfig Split materializado.
 * @returns {{ amountInCents: number, depixSplitAddress: string, splitFee: string }} Payload externo.
 */
function createDiagnosticEulenDepositPayload(amountInCents, splitConfig) {
  return {
    amountInCents,
    depixSplitAddress: splitConfig.depixSplitAddress,
    splitFee: splitConfig.splitFee,
  };
}

/**
 * Remove separadores visuais de um endereco de split.
 *
 * A SideSwap pode exibir enderecos em grupos para leitura humana. A API deve
 * receber o endereco canonico, sem espacos, tabs ou quebras de linha.
 *
 * @param {string} depixSplitAddress Endereco bruto materializado do secret.
 * @returns {string} Endereco canonico para classificacao, payload e persistencia.
 */
function normalizeDiagnosticSplitAddress(depixSplitAddress) {
  return depixSplitAddress.replace(/\s+/g, "");
}

/**
 * Normaliza a configuracao de split materializada do Secrets Store.
 *
 * @param {{ depixSplitAddress: string, splitFee: string }} splitConfig Split bruto.
 * @returns {{ depixSplitAddress: string, splitFee: string }} Split canonico.
 */
function normalizeDiagnosticSplitConfig(splitConfig) {
  return {
    depixSplitAddress: normalizeDiagnosticSplitAddress(splitConfig.depixSplitAddress),
    splitFee: splitConfig.splitFee.trim(),
  };
}

/**
 * Classifica um endereco de split sem devolver o valor real.
 *
 * O objetivo e diferenciar `ex1...`, `lq1...` da SideSwap, URI copiada de
 * carteira ou valor estranho, sem colocar dado financeiro operacional em log
 * ou resposta HTTP.
 *
 * @param {string} depixSplitAddress Endereco real ja materializado.
 * @returns {"documented-depix" | "liquid-confidential" | "uri" | "unknown"} Familia redigida.
 */
function classifyDiagnosticSplitAddress(depixSplitAddress) {
  const normalizedAddress = normalizeDiagnosticSplitAddress(depixSplitAddress).toLowerCase();

  if (normalizedAddress.startsWith("ex1")) {
    return "documented-depix";
  }

  if (normalizedAddress.startsWith("lq1")) {
    return "liquid-confidential";
  }

  if (normalizedAddress.includes(":") || normalizedAddress.includes("?")) {
    return "uri";
  }

  return "unknown";
}

/**
 * Descreve a configuracao de split sem expor os valores sensiveis.
 *
 * @param {{ depixSplitAddress: string, splitFee: string }} splitConfig Split materializado.
 * @returns {{
 *   depixSplitAddressLength: number,
 *   depixSplitAddressKind: string,
 *   splitFeeLength: number,
 *   splitFeeLooksPercent: boolean,
 *   splitFeeLooksNumeric: boolean
 * }} Metadados seguros para troubleshooting.
 */
function describeDiagnosticSplitConfig(splitConfig) {
  const splitFee = splitConfig.splitFee.trim();
  const depixSplitAddress = normalizeDiagnosticSplitAddress(splitConfig.depixSplitAddress);

  return {
    depixSplitAddressLength: depixSplitAddress.length,
    depixSplitAddressKind: classifyDiagnosticSplitAddress(depixSplitAddress),
    splitFeeLength: splitFee.length,
    splitFeeLooksPercent: /^\d+(?:\.\d{1,2})%$/.test(splitFee),
    splitFeeLooksNumeric: /^\d+(?:\.\d{1,2})?$/.test(splitFee),
  };
}

/**
 * Converte falhas async do client Eulen para codigos estaveis do diagnostico.
 *
 * O client conhece o contrato de transporte da Eulen; este service conhece a
 * semantica operacional da rota `/ops`. Essa fronteira evita workaround dentro
 * da rota e preserva mensagens especificas para quem esta validando a issue.
 *
 * @param {EulenApiError} error Erro padronizado pelo client Eulen.
 * @param {Record<string, unknown>} contextDetails Contexto seguro da rota.
 * @returns {DiagnosticServiceError | undefined} Erro diagnostico quando a falha for async.
 */
function mapEulenAsyncErrorToDiagnosticError(error, contextDetails = {}) {
  const details = {
    ...contextDetails,
    ...error.details,
  };

  if (error.details?.code === "eulen_async_result_failed") {
    return new DiagnosticServiceError(
      502,
      "eulen_async_deposit_failed",
      "Eulen asynchronous deposit result returned an error.",
      details,
    );
  }

  if (error.details?.code === "eulen_async_result_unavailable") {
    return new DiagnosticServiceError(
      502,
      "eulen_async_deposit_result_unavailable",
      "Eulen asynchronous deposit result could not be read.",
      details,
    );
  }

  if (error.details?.code === "eulen_async_result_timeout") {
    return new DiagnosticServiceError(
      504,
      "eulen_async_deposit_result_timeout",
      "Eulen asynchronous deposit result was not available within the diagnostic polling window.",
      details,
    );
  }

  return undefined;
}

/**
 * Executa uma chamada para a Bot API do Telegram.
 *
 * @param {string} botToken Token real do bot.
 * @param {string} method Metodo da Bot API.
 * @param {Record<string, unknown>=} payload Payload opcional.
 * @returns {Promise<{ ok: true, httpStatus: number, body: Record<string, unknown> | null }>} Resultado da chamada.
 */
async function callTelegramApi(botToken, method, payload) {
  try {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${botToken}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const responseBody = await response.json().catch(() => null);

    if (!response.ok || responseBody?.ok === false) {
      throw new DiagnosticServiceError(502, "telegram_api_request_failed", `Telegram API call ${method} failed.`, {
        method,
        httpStatus: response.status,
        responseBody,
      });
    }

    return {
      ok: true,
      httpStatus: response.status,
      body: responseBody,
    };
  } catch (error) {
    if (error instanceof DiagnosticServiceError) {
      throw error;
    }

    throw new DiagnosticServiceError(502, "telegram_api_transport_failed", `Telegram API call ${method} could not be completed.`, {
      method,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Monta o estado atual do webhook do Telegram para um tenant.
 *
 * @param {{
 *   enableLocalDiagnostics?: string,
 *   env: Record<string, unknown>,
 *   tenant: { tenantId: string, secretBindings: Record<string, string> },
 *   environment: string,
 *   publicBaseUrl?: string
 * }} input Dependencias do diagnostico.
 * @returns {Promise<Record<string, unknown>>} Estado atual do bot e webhook.
 */
export async function getTelegramWebhookDiagnostics(input) {
  assertLocalDiagnosticsEnabled(input.enableLocalDiagnostics);

  const telegramBotToken = await readRequiredDiagnosticTenantSecret(input.env, input.tenant, "telegramBotToken");
  const expectedWebhookUrl = input.publicBaseUrl
    ? `${input.publicBaseUrl}/telegram/${input.tenant.tenantId}/webhook`
    : undefined;
  const [meResult, webhookResult] = await Promise.all([
    callTelegramApi(telegramBotToken, "getMe"),
    callTelegramApi(telegramBotToken, "getWebhookInfo"),
  ]);

  return {
    ok: true,
    tenantId: input.tenant.tenantId,
    environment: input.environment,
    expectedWebhookUrl,
    getMe: meResult,
    getWebhookInfo: webhookResult,
  };
}

/**
 * Registra o webhook do Telegram para o tenant informado.
 *
 * @param {{
 *   enableLocalDiagnostics?: string,
 *   env: Record<string, unknown>,
 *   tenant: { tenantId: string, secretBindings: Record<string, string> },
 *   environment: string,
 *   publicBaseUrl: string
 * }} input Dependencias do diagnostico.
 * @returns {Promise<Record<string, unknown>>} Resultado da operacao.
 */
export async function registerTelegramWebhookDiagnostic(input) {
  assertLocalDiagnosticsEnabled(input.enableLocalDiagnostics);

  if (!input.publicBaseUrl) {
    throw new DiagnosticServiceError(400, "public_base_url_required", "A valid publicBaseUrl is required.");
  }

  const telegramBotToken = await readRequiredDiagnosticTenantSecret(input.env, input.tenant, "telegramBotToken");
  const telegramWebhookSecret = await readRequiredDiagnosticTenantSecret(input.env, input.tenant, "telegramWebhookSecret");
  const webhookUrl = `${input.publicBaseUrl}/telegram/${input.tenant.tenantId}/webhook`;
  const setWebhookResult = await callTelegramApi(telegramBotToken, "setWebhook", {
    url: webhookUrl,
    secret_token: telegramWebhookSecret,
    allowed_updates: ["message"],
  });
  const webhookInfoResult = await callTelegramApi(telegramBotToken, "getWebhookInfo");

  return {
    ok: true,
    tenantId: input.tenant.tenantId,
    environment: input.environment,
    webhookUrl,
    setWebhook: setWebhookResult,
    getWebhookInfo: webhookInfoResult,
  };
}

/**
 * Executa um ping autenticado na Eulen.
 *
 * @param {{
 *   enableLocalDiagnostics?: string,
 *   env: Record<string, unknown>,
 *   tenant: { tenantId: string, eulenPartnerId?: string, secretBindings: Record<string, string> },
 *   runtimeConfig: { environment: string, eulenApiBaseUrl: string, eulenApiTimeoutMs: number }
 *   asyncMode: "auto" | "true" | "false"
 * }} input Dependencias do diagnostico.
 * @returns {Promise<Record<string, unknown>>} Resultado do ping.
 */
export async function pingEulenDiagnostic(input) {
  assertLocalDiagnosticsEnabled(input.enableLocalDiagnostics);

  try {
    const response = await pingEulen(input.runtimeConfig, {
      apiToken: await readRequiredDiagnosticTenantSecret(input.env, input.tenant, "eulenApiToken"),
      partnerId: input.tenant.eulenPartnerId,
    }, {
      asyncMode: input.asyncMode,
    });

    return {
      ok: true,
      tenantId: input.tenant.tenantId,
      environment: input.runtimeConfig.environment,
      response,
    };
  } catch (error) {
    if (error instanceof EulenApiError) {
      throw new DiagnosticServiceError(502, "eulen_api_request_failed", error.message, {
        tenantId: input.tenant.tenantId,
        environment: input.runtimeConfig.environment,
        asyncMode: input.asyncMode,
        ...error.details,
      });
    }

    throw error;
  }
}

/**
 * Cria um deposito real na Eulen e persiste o agregado minimo no D1 remoto.
 *
 * @param {{
 *   enableLocalDiagnostics?: string,
 *   env: Record<string, unknown>,
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenant: {
 *     tenantId: string,
 *     eulenPartnerId?: string,
 *     splitConfigBindings: { depixSplitAddress: string, splitFee: string },
 *     secretBindings: Record<string, string>
 *   },
 *   runtimeConfig: { environment: string, eulenApiBaseUrl: string, eulenApiTimeoutMs: number },
 *   amountInCents: number,
 *   asyncMode: "auto" | "true" | "false"
 * }} input Dependencias do diagnostico.
 * @returns {Promise<Record<string, unknown>>} IDs e payload persistido.
 */
export async function createEulenDiagnosticDeposit(input) {
  assertLocalDiagnosticsEnabled(input.enableLocalDiagnostics);

  const splitConfig = normalizeDiagnosticSplitConfig(
    await readRequiredDiagnosticTenantSplitConfig(input.env, input.tenant),
  );
  assertDiagnosticSplitConfigReady(input.tenant.tenantId, splitConfig);

  const orderId = `issue42_${input.tenant.tenantId}_${Date.now()}`;
  let response;

  try {
    response = await createEulenDeposit(input.runtimeConfig, {
      apiToken: await readRequiredDiagnosticTenantSecret(input.env, input.tenant, "eulenApiToken"),
      partnerId: input.tenant.eulenPartnerId,
    }, {
      asyncMode: input.asyncMode,
      body: createDiagnosticEulenDepositPayload(input.amountInCents, splitConfig),
    });
    response = await resolveEulenAsyncResponse(response);
  } catch (error) {
    if (error instanceof DiagnosticServiceError) {
      throw error;
    }

    if (error instanceof EulenApiError) {
      const diagnosticError = mapEulenAsyncErrorToDiagnosticError(error, {
        tenantId: input.tenant.tenantId,
        environment: input.runtimeConfig.environment,
        asyncMode: input.asyncMode,
        splitConfigDiagnostics: describeDiagnosticSplitConfig(splitConfig),
      });

      if (diagnosticError) {
        throw diagnosticError;
      }

      throw new DiagnosticServiceError(502, "eulen_api_request_failed", error.message, {
        tenantId: input.tenant.tenantId,
        environment: input.runtimeConfig.environment,
        asyncMode: input.asyncMode,
        splitConfigDiagnostics: describeDiagnosticSplitConfig(splitConfig),
        ...error.details,
      });
    }

    throw error;
  }

  const depositPayload = response?.data?.response;
  const depositId = typeof depositPayload?.id === "string" ? depositPayload.id : undefined;
  const qrCopyPaste = typeof depositPayload?.qrCopyPaste === "string" ? depositPayload.qrCopyPaste : undefined;
  const qrImageUrl = typeof depositPayload?.qrImageUrl === "string" ? depositPayload.qrImageUrl : undefined;

  if (!depositId || !qrCopyPaste || !qrImageUrl) {
    throw new DiagnosticServiceError(502, "invalid_eulen_deposit_response", "Eulen deposit response did not contain the required fields.", {
      tenantId: input.tenant.tenantId,
      environment: input.runtimeConfig.environment,
      response,
    });
  }

  try {
    await createOrder(input.db, {
      tenantId: input.tenant.tenantId,
      orderId,
      userId: `issue42_${input.tenant.tenantId}`,
      channel: "ops",
      productType: "depix",
      amountInCents: input.amountInCents,
      walletAddress: null,
      currentStep: "awaiting_payment",
      status: "pending",
      splitAddress: splitConfig.depixSplitAddress,
      splitFee: splitConfig.splitFee,
    });

    const deposit = await createDeposit(input.db, {
      tenantId: input.tenant.tenantId,
      depositId,
      orderId,
      nonce: response.nonce,
      qrCopyPaste,
      qrImageUrl,
      externalStatus: "pending",
      expiration: null,
    });

    return {
      ok: true,
      tenantId: input.tenant.tenantId,
      environment: input.runtimeConfig.environment,
      orderId,
      deposit,
      response,
    };
  } catch (error) {
    throw new DiagnosticServiceError(500, "diagnostic_seed_failed", "The local diagnostic aggregate could not be persisted.", {
      tenantId: input.tenant.tenantId,
      orderId,
      depositId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
