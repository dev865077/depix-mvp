/**
 * Operacoes autenticadas de webhook do Telegram.
 *
 * Este modulo existe para tornar verificacao e registro de webhook uma
 * ferramenta real de suporte, sem depender do gate de diagnostico local usado
 * por investigacoes de desenvolvimento. O contrato aqui e:
 * - autenticar na Bot API com os segredos reais do tenant
 * - nunca expor o token do bot nem o secret do webhook
 * - devolver apenas metadados operacionais e respostas redigidas do Telegram
 */
import { readTenantSecret } from "../config/tenants.js";
import {
  buildTelegramPublicCommandsPayload,
  buildTelegramPublicDescriptionPayload,
  buildTelegramPublicMenuButtonPayload,
  buildTelegramPublicShortDescriptionPayload,
  buildTelegramPublicSurfaceInventory,
  summarizeTelegramCommandsResponse,
  summarizeTelegramMenuButtonResponse,
  TELEGRAM_ALLOWED_UPDATES,
} from "../telegram/public-surface.js";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const telegramPublicSurfaceEnsureCache = new Map();

/**
 * Erro controlado das operacoes de webhook do Telegram.
 *
 * A borda HTTP converte este erro em JSON estavel sem precisar conhecer a
 * origem exata da falha interna.
 */
export class TelegramWebhookOpsError extends Error {
  /**
   * @param {number} status Status HTTP desejado para a resposta.
   * @param {string} code Codigo estavel para troubleshooting.
   * @param {string} message Mensagem principal.
   * @param {Record<string, unknown>=} details Metadados adicionais.
   * @param {unknown=} cause Erro original.
   */
  constructor(status, code, message, details = {}, cause = undefined) {
    super(message, {
      cause,
    });

    this.name = "TelegramWebhookOpsError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Le um segredo obrigatorio do tenant com erro operacional estruturado.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {{ tenantId: string, secretBindings?: Record<string, string> }} tenant Tenant atual.
 * @param {"telegramBotToken" | "telegramWebhookSecret"} secretKey Chave logica do segredo.
 * @returns {Promise<string>} Valor materializado do segredo.
 */
async function readRequiredTelegramTenantSecret(env, tenant, secretKey) {
  const bindingName = tenant.secretBindings?.[secretKey];

  try {
    return await readTenantSecret(env, tenant, secretKey);
  } catch (error) {
    throw new TelegramWebhookOpsError(
      503,
      "telegram_webhook_dependency_unavailable",
      `Telegram webhook operation could not resolve the tenant secret ${secretKey}.`,
      {
        tenantId: tenant.tenantId,
        secretKey,
        bindingName,
        cause: error instanceof Error ? error.message : String(error),
      },
      error,
    );
  }
}

/**
 * Normaliza uma URL base publica para operacoes do webhook.
 *
 * @param {string | undefined} rawBaseUrl URL bruta informada pelo operador.
 * @returns {string | null} URL canonica sem barra final.
 */
export function normalizeTelegramWebhookPublicBaseUrl(rawBaseUrl) {
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim().length === 0) {
    return null;
  }

  try {
    return new URL(rawBaseUrl).toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

/**
 * Monta a URL canonica do webhook para um tenant.
 *
 * @param {string} publicBaseUrl Base publica do Worker.
 * @param {string} tenantId Tenant atual.
 * @returns {string} URL final do webhook.
 */
function buildTelegramWebhookUrl(publicBaseUrl, tenantId) {
  return `${publicBaseUrl}/telegram/${tenantId}/webhook`;
}

export function clearTelegramWebhookPublicSurfaceEnsureCache() {
  telegramPublicSurfaceEnsureCache.clear();
}

/**
 * Executa uma chamada para a Bot API do Telegram.
 *
 * @param {string} botToken Token real do bot.
 * @param {string} method Metodo da Bot API.
 * @param {Record<string, unknown>=} payload Payload opcional.
 * @returns {Promise<{ ok: true, httpStatus: number, body: Record<string, unknown> | null }>} Resultado bruto redigido.
 */
async function callTelegramApi(botToken, method, payload = undefined) {
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
      throw new TelegramWebhookOpsError(
        502,
        "telegram_api_request_failed",
        `Telegram API call ${method} failed.`,
        {
          method,
          httpStatus: response.status,
          responseBody,
        },
      );
    }

    return {
      ok: true,
      httpStatus: response.status,
      body: responseBody,
    };
  } catch (error) {
    if (error instanceof TelegramWebhookOpsError) {
      throw error;
    }

    throw new TelegramWebhookOpsError(
      502,
      "telegram_api_transport_failed",
      `Telegram API call ${method} could not be completed.`,
      {
        method,
        cause: error instanceof Error ? error.message : String(error),
      },
      error,
    );
  }
}

/**
 * Resume a identidade publica do bot sem expor o payload cru da Bot API.
 *
 * @param {Record<string, unknown> | null | undefined} responseBody Corpo decodificado de `getMe`.
 * @returns {{ id: number | null, isBot: boolean | null, username: string | null }} Shape redigido.
 */
function summarizeTelegramBotIdentity(responseBody) {
  const result = responseBody?.result;

  return {
    id: typeof result?.id === "number" ? result.id : null,
    isBot: typeof result?.is_bot === "boolean" ? result.is_bot : null,
    username: typeof result?.username === "string" ? result.username : null,
  };
}

/**
 * Resume o estado do webhook em um shape operacional estavel.
 *
 * @param {Record<string, unknown> | null | undefined} responseBody Corpo decodificado de `getWebhookInfo`.
 * @returns {{
 *   url: string | null,
 *   hasCustomCertificate: boolean | null,
 *   pendingUpdateCount: number | null,
 *   maxConnections: number | null,
 *   allowedUpdates: string[] | null,
 *   lastErrorDate: number | null,
 *   lastErrorMessage: string | null
 * }} Estado redigido do webhook.
 */
function summarizeTelegramWebhookInfo(responseBody) {
  const result = responseBody?.result;

  return {
    url: typeof result?.url === "string" ? result.url : null,
    hasCustomCertificate: typeof result?.has_custom_certificate === "boolean"
      ? result.has_custom_certificate
      : null,
    pendingUpdateCount: Number.isInteger(result?.pending_update_count)
      ? result.pending_update_count
      : null,
    maxConnections: Number.isInteger(result?.max_connections)
      ? result.max_connections
      : null,
    allowedUpdates: Array.isArray(result?.allowed_updates)
      ? result.allowed_updates.filter((entry) => typeof entry === "string")
      : null,
    lastErrorDate: Number.isInteger(result?.last_error_date) ? result.last_error_date : null,
    lastErrorMessage: typeof result?.last_error_message === "string"
      ? result.last_error_message
      : null,
  };
}

function hasCanonicalAllowedUpdates(allowedUpdates) {
  if (!Array.isArray(allowedUpdates)) {
    return false;
  }

  return TELEGRAM_ALLOWED_UPDATES.every(function hasAllowedUpdate(updateType) {
    return allowedUpdates.includes(updateType);
  });
}

function buildTelegramPublicSurfaceCalls(telegramBotToken) {
  return [
    {
      method: "setMyDescription",
      run: () => callTelegramApi(telegramBotToken, "setMyDescription", buildTelegramPublicDescriptionPayload()),
    },
    {
      method: "setMyShortDescription",
      run: () => callTelegramApi(telegramBotToken, "setMyShortDescription", buildTelegramPublicShortDescriptionPayload()),
    },
    {
      method: "setMyCommands",
      run: () => callTelegramApi(telegramBotToken, "setMyCommands", {
        commands: buildTelegramPublicCommandsPayload(),
      }),
    },
    {
      method: "setChatMenuButton",
      run: () => callTelegramApi(telegramBotToken, "setChatMenuButton", {
        menu_button: buildTelegramPublicMenuButtonPayload(),
      }),
    },
  ];
}

function summarizeTelegramPublicSurfaceFailures(calls, settledResults) {
  return settledResults.flatMap(function toFailure(settledResult, index) {
    if (settledResult.status === "fulfilled") {
      return [];
    }

    const reason = settledResult.reason;

    return [{
      method: calls[index]?.method ?? "unknown",
      error: reason instanceof Error ? reason.message : String(reason),
    }];
  });
}

async function refreshTelegramPublicSurfaceBestEffort(telegramBotToken) {
  const publicSurfaceCalls = buildTelegramPublicSurfaceCalls(telegramBotToken);
  const settledResults = await Promise.allSettled(publicSurfaceCalls.map(function runPublicSurfaceCall(call) {
    return call.run();
  }));
  const failures = summarizeTelegramPublicSurfaceFailures(publicSurfaceCalls, settledResults);

  return {
    ok: failures.length === 0,
    failures,
  };
}

/**
 * Busca `getMe` e `getWebhookInfo` do tenant autenticado.
 *
 * @param {{
 *   env: Record<string, unknown>,
 *   tenant: { tenantId: string, secretBindings?: Record<string, string> },
 *   environment: string,
 *   publicBaseUrl?: string | null
 * }} input Dependencias operacionais.
 * @returns {Promise<Record<string, unknown>>} Snapshot do bot e do webhook.
 */
export async function getTelegramWebhookOpsInfo(input) {
  const telegramBotToken = await readRequiredTelegramTenantSecret(input.env, input.tenant, "telegramBotToken");
  const expectedWebhookUrl = input.publicBaseUrl
    ? buildTelegramWebhookUrl(input.publicBaseUrl, input.tenant.tenantId)
    : null;
  const [getMeResult, getWebhookInfoResult, getMyCommandsResult, getChatMenuButtonResult] = await Promise.all([
    callTelegramApi(telegramBotToken, "getMe"),
    callTelegramApi(telegramBotToken, "getWebhookInfo"),
    callTelegramApi(telegramBotToken, "getMyCommands"),
    callTelegramApi(telegramBotToken, "getChatMenuButton"),
  ]);

  return {
    ok: true,
    tenantId: input.tenant.tenantId,
    environment: input.environment,
    expectedWebhookUrl,
    telegramApi: {
      getMeHttpStatus: getMeResult.httpStatus,
      getWebhookInfoHttpStatus: getWebhookInfoResult.httpStatus,
      getMyCommandsHttpStatus: getMyCommandsResult.httpStatus,
      getChatMenuButtonHttpStatus: getChatMenuButtonResult.httpStatus,
    },
    bot: summarizeTelegramBotIdentity(getMeResult.body),
    webhook: summarizeTelegramWebhookInfo(getWebhookInfoResult.body),
    commands: summarizeTelegramCommandsResponse(getMyCommandsResult.body),
    menuButton: summarizeTelegramMenuButtonResponse(getChatMenuButtonResult.body),
    expectedPublicSurface: buildTelegramPublicSurfaceInventory(),
  };
}

export async function ensureTelegramWebhookPublicSurface(input) {
  if (!input.publicBaseUrl) {
    return {
      ok: false,
      repaired: false,
      reason: "public_base_url_missing",
    };
  }

  const webhookUrl = buildTelegramWebhookUrl(input.publicBaseUrl, input.tenant.tenantId);
  const cacheKey = `${input.environment}:${input.tenant.tenantId}:${webhookUrl}:telegram-public-surface-v1`;
  const cachedResult = telegramPublicSurfaceEnsureCache.get(cacheKey);

  if (cachedResult) {
    return {
      ...cachedResult,
      cacheHit: true,
    };
  }

  const [telegramBotToken, telegramWebhookSecret] = input.telegramBotToken && input.telegramWebhookSecret
    ? [input.telegramBotToken, input.telegramWebhookSecret]
    : await Promise.all([
      readRequiredTelegramTenantSecret(input.env, input.tenant, "telegramBotToken"),
      readRequiredTelegramTenantSecret(input.env, input.tenant, "telegramWebhookSecret"),
    ]);
  const webhookInfoResult = await callTelegramApi(telegramBotToken, "getWebhookInfo");
  const webhook = summarizeTelegramWebhookInfo(webhookInfoResult.body);
  const needsRepair = webhook.url !== webhookUrl || !hasCanonicalAllowedUpdates(webhook.allowedUpdates);
  const publicSurfaceRefresh = await refreshTelegramPublicSurfaceBestEffort(telegramBotToken);

  if (!needsRepair) {
    const result = {
      ok: true,
      repaired: false,
      webhookUrl,
      allowedUpdates: webhook.allowedUpdates,
      publicSurfaceRefresh,
    };

    telegramPublicSurfaceEnsureCache.set(cacheKey, result);
    return result;
  }

  await Promise.all([
    callTelegramApi(telegramBotToken, "setWebhook", {
      url: webhookUrl,
      secret_token: telegramWebhookSecret,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    }),
  ]);

  const result = {
    ok: true,
    repaired: true,
    webhookUrl,
    previousWebhookUrl: webhook.url,
    previousAllowedUpdates: webhook.allowedUpdates,
    allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
    publicSurfaceRefresh,
  };

  telegramPublicSurfaceEnsureCache.set(cacheKey, result);
  return result;
}

/**
 * Registra explicitamente o webhook do tenant atual.
 *
 * @param {{
 *   env: Record<string, unknown>,
 *   tenant: { tenantId: string, secretBindings?: Record<string, string> },
 *   environment: string,
 *   publicBaseUrl: string | null
 * }} input Dependencias operacionais.
 * @returns {Promise<Record<string, unknown>>} Resultado da operacao.
 */
export async function registerTelegramWebhookOps(input) {
  if (!input.publicBaseUrl) {
    throw new TelegramWebhookOpsError(
      400,
      "public_base_url_required",
      "A valid publicBaseUrl is required to register the Telegram webhook.",
    );
  }

  const [telegramBotToken, telegramWebhookSecret] = await Promise.all([
    readRequiredTelegramTenantSecret(input.env, input.tenant, "telegramBotToken"),
    readRequiredTelegramTenantSecret(input.env, input.tenant, "telegramWebhookSecret"),
  ]);
  const webhookUrl = buildTelegramWebhookUrl(input.publicBaseUrl, input.tenant.tenantId);
  const setWebhookResult = await callTelegramApi(telegramBotToken, "setWebhook", {
    url: webhookUrl,
    secret_token: telegramWebhookSecret,
    allowed_updates: TELEGRAM_ALLOWED_UPDATES,
  });
  const [setMyCommandsResult, setChatMenuButtonResult, setMyDescriptionResult, setMyShortDescriptionResult] = await Promise.all([
    callTelegramApi(telegramBotToken, "setMyCommands", {
      commands: buildTelegramPublicCommandsPayload(),
    }),
    callTelegramApi(telegramBotToken, "setChatMenuButton", {
      menu_button: buildTelegramPublicMenuButtonPayload(),
    }),
    callTelegramApi(telegramBotToken, "setMyDescription", buildTelegramPublicDescriptionPayload()),
    callTelegramApi(telegramBotToken, "setMyShortDescription", buildTelegramPublicShortDescriptionPayload()),
  ]);
  const [getWebhookInfoResult, getMyCommandsResult, getChatMenuButtonResult] = await Promise.all([
    callTelegramApi(telegramBotToken, "getWebhookInfo"),
    callTelegramApi(telegramBotToken, "getMyCommands"),
    callTelegramApi(telegramBotToken, "getChatMenuButton"),
  ]);

  return {
    ok: true,
    tenantId: input.tenant.tenantId,
    environment: input.environment,
    webhookUrl,
    telegramApi: {
      setWebhookHttpStatus: setWebhookResult.httpStatus,
      setMyCommandsHttpStatus: setMyCommandsResult.httpStatus,
      setChatMenuButtonHttpStatus: setChatMenuButtonResult.httpStatus,
      setMyDescriptionHttpStatus: setMyDescriptionResult.httpStatus,
      setMyShortDescriptionHttpStatus: setMyShortDescriptionResult.httpStatus,
      getWebhookInfoHttpStatus: getWebhookInfoResult.httpStatus,
      getMyCommandsHttpStatus: getMyCommandsResult.httpStatus,
      getChatMenuButtonHttpStatus: getChatMenuButtonResult.httpStatus,
    },
    registered: true,
    webhook: summarizeTelegramWebhookInfo(getWebhookInfoResult.body),
    commands: summarizeTelegramCommandsResponse(getMyCommandsResult.body),
    menuButton: summarizeTelegramMenuButtonResponse(getChatMenuButtonResult.body),
    expectedPublicSurface: buildTelegramPublicSurfaceInventory(),
  };
}
