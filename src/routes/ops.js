/**
 * Rotas operacionais internas.
 *
 * Este router abriga:
 * - a operacao placeholder de recheck
 * - rotas locais de diagnostico para a issue #42
 *
 * O desenho aqui e intencionalmente fino: a borda HTTP faz apenas validacao
 * de contexto, parse de entrada e traducao de erros. Toda regra de diagnostico
 * e integracao externa fica em `local-diagnostic-validation.js`.
 */
import { Hono } from "hono";

import { jsonNotImplemented } from "../lib/http.js";
import {
  createEulenDiagnosticDeposit,
  DiagnosticServiceError,
  getTelegramWebhookDiagnostics,
  normalizeDiagnosticPublicBaseUrl,
  parseDiagnosticJsonBody,
  pingEulenDiagnostic,
  readDiagnosticAmountInCents,
  readDiagnosticAsyncMode,
  registerTelegramWebhookDiagnostic,
} from "../services/local-diagnostic-validation.js";

export const opsRouter = new Hono();

/**
 * Converte erros conhecidos do service de diagnostico para JSON padronizado.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @param {unknown} error Erro capturado durante a execucao.
 * @returns {Response} Resposta pronta para a borda HTTP.
 */
function handleDiagnosticRouteError(c, error) {
  if (error instanceof DiagnosticServiceError) {
    return c.json({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    }, error.status);
  }

  throw error;
}

/**
 * Placeholder da operacao de recheck de deposito.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Response} Resposta 501 padronizada.
 */
export function handleDepositRecheck(c) {
  const tenant = c.get("tenant");

  return jsonNotImplemented(c, "Deposit recheck operation", {
    tenantId: tenant?.tenantId,
  });
}

/**
 * Busca `getMe` e `getWebhookInfo` do bot do tenant atual.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} Estado atual do webhook no Telegram.
 */
export async function handleTelegramWebhookInfo(c) {
  try {
    const tenant = c.get("tenant");
    const runtimeConfig = c.get("runtimeConfig");

    if (!tenant) {
      throw new DiagnosticServiceError(400, "tenant_required", "Resolved tenant is required.");
    }

    return c.json(await getTelegramWebhookDiagnostics({
      enableLocalDiagnostics: c.env.ENABLE_LOCAL_DIAGNOSTICS,
      env: c.env,
      tenant,
      environment: runtimeConfig.environment,
      publicBaseUrl: normalizeDiagnosticPublicBaseUrl(c.req.query("baseUrl") ?? undefined),
    }));
  } catch (error) {
    return handleDiagnosticRouteError(c, error);
  }
}

/**
 * Registra explicitamente o webhook do Telegram para o tenant atual.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} Resultado da operacao de registro.
 */
export async function handleTelegramWebhookRegistration(c) {
  try {
    const tenant = c.get("tenant");
    const runtimeConfig = c.get("runtimeConfig");

    if (!tenant) {
      throw new DiagnosticServiceError(400, "tenant_required", "Resolved tenant is required.");
    }

    const body = parseDiagnosticJsonBody(await c.req.text());
    const publicBaseUrl = normalizeDiagnosticPublicBaseUrl(
      typeof body.publicBaseUrl === "string" ? body.publicBaseUrl : undefined,
    );

    return c.json(await registerTelegramWebhookDiagnostic({
      enableLocalDiagnostics: c.env.ENABLE_LOCAL_DIAGNOSTICS,
      env: c.env,
      tenant,
      environment: runtimeConfig.environment,
      publicBaseUrl,
    }));
  } catch (error) {
    return handleDiagnosticRouteError(c, error);
  }
}

/**
 * Executa um ping autenticado na Eulen com as credenciais do tenant atual.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} Resultado do ping na Eulen.
 */
export async function handleEulenPing(c) {
  try {
    const tenant = c.get("tenant");
    const runtimeConfig = c.get("runtimeConfig");

    if (!tenant) {
      throw new DiagnosticServiceError(400, "tenant_required", "Resolved tenant is required.");
    }

    // Ping e diagnostico de conectividade/autenticacao, nao validacao de SLA
    // sincrono da Eulen. O modo async explicito evita que um tenant saudavel
    // pareca indisponivel quando o upstream descarta a janela sync curta.
    return c.json(await pingEulenDiagnostic({
      enableLocalDiagnostics: c.env.ENABLE_LOCAL_DIAGNOSTICS,
      env: c.env,
      tenant,
      runtimeConfig,
      asyncMode: readDiagnosticAsyncMode(c.req.query("asyncMode") ?? undefined, {}, "true"),
    }));
  } catch (error) {
    return handleDiagnosticRouteError(c, error);
  }
}

/**
 * Cria um deposito real na Eulen e persiste o agregado minimo no D1 remoto.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} IDs e payload persistido para a validacao.
 */
export async function handleEulenCreateDeposit(c) {
  try {
    const tenant = c.get("tenant");
    const runtimeConfig = c.get("runtimeConfig");
    const db = c.get("db");

    if (!tenant) {
      throw new DiagnosticServiceError(400, "tenant_required", "Resolved tenant is required.");
    }

    if (!db) {
      throw new DiagnosticServiceError(500, "database_required", "Database binding is required.");
    }

    const body = parseDiagnosticJsonBody(await c.req.text());

    return c.json(await createEulenDiagnosticDeposit({
      enableLocalDiagnostics: c.env.ENABLE_LOCAL_DIAGNOSTICS,
      env: c.env,
      db,
      tenant,
      runtimeConfig,
      amountInCents: readDiagnosticAmountInCents(body),
      asyncMode: readDiagnosticAsyncMode(c.req.query("asyncMode") ?? undefined, body),
    }));
  } catch (error) {
    return handleDiagnosticRouteError(c, error);
  }
}

// O recheck fica isolado por tenant para alinhar o fallback com o mesmo
// escopo do webhook principal. As rotas de diagnostico continuam no mesmo
// namespace operacional, mas sua implementacao vive no service dedicado.
opsRouter.post("/:tenantId/recheck/deposit", handleDepositRecheck);
opsRouter.get("/:tenantId/telegram/webhook-info", handleTelegramWebhookInfo);
opsRouter.post("/:tenantId/telegram/register-webhook", handleTelegramWebhookRegistration);
opsRouter.get("/:tenantId/eulen/ping", handleEulenPing);
opsRouter.post("/:tenantId/eulen/create-deposit", handleEulenCreateDeposit);
