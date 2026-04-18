/**
 * Rotas operacionais internas.
 *
 * Este router abriga:
 * - o recheck operacional de deposito via `deposit-status`
 * - rotas locais de diagnostico para a issue #42
 *
 * O desenho aqui e intencionalmente fino: a borda HTTP faz apenas validacao
 * de contexto, parse de entrada e traducao de erros. A regra de reconciliacao
 * operacional vive em `eulen-deposit-recheck.js`; as rotas de diagnostico da
 * issue #42 continuam isoladas em `local-diagnostic-validation.js`.
 */
import { Hono } from "hono";

import { readTenantSecret } from "../config/tenants.js";
import { jsonError } from "../lib/http.js";
import { log } from "../lib/logger.js";
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
import {
  authorizeOpsRoute,
  OpsRouteAuthorizationError,
} from "../services/ops-route-authorization.js";
import { DepositsFallbackError, processDepositsFallback } from "../services/eulen-deposits-fallback.js";
import { DepositRecheckError, processDepositRecheck } from "../services/eulen-deposit-recheck.js";

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
 * Converte erros conhecidos das rotas de reconciliacao para JSON padronizado.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @param {unknown} error Erro capturado durante a execucao.
 * @param {{ authorizationFailed: string, operationFailed: string }} messages Mensagens de log especificas da rota.
 * @returns {Response} Resposta pronta para a borda HTTP.
 */
function handleReconciliationRouteError(c, error, messages) {
  const runtimeConfig = c.get("runtimeConfig");

  if (error instanceof OpsRouteAuthorizationError) {
    log(runtimeConfig, {
      level: error.status >= 500 ? "error" : "warn",
      message: messages.authorizationFailed,
      tenantId: c.get("tenant")?.tenantId,
      requestId: c.get("requestId"),
      details: {
        code: error.code,
        path: c.req.path,
        ...error.details,
      },
    });

    return jsonError(c, error.status, error.code, error.message, error.details);
  }

  if (error instanceof DepositRecheckError || error instanceof DepositsFallbackError) {
    log(runtimeConfig, {
      level: error.status >= 500 ? "error" : "warn",
      message: messages.operationFailed,
      tenantId: c.get("tenant")?.tenantId,
      requestId: c.get("requestId"),
      details: {
        code: error.code,
        path: c.req.path,
        ...error.details,
      },
    });

    return jsonError(c, error.status, error.code, error.message, error.details);
  }

  throw error;
}

/**
 * Resolve dependencias comuns das rotas operacionais de reconciliacao.
 *
 * As duas rotas atuais, `deposit-status` e `deposits`, compartilham o mesmo
 * contrato de rollout: tenant resolvido, bearer operacional, D1 configurado e
 * token Eulen do tenant. Centralizar essa borda evita divergencia de auth entre
 * ferramentas que escrevem no mesmo agregado financeiro.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @param {string} authorizationLogMessage Mensagem de log para auth bem sucedida.
 * @param {{ code: string, message: string }} dependencyError Erro usado quando secrets Eulen faltarem.
 * @param {typeof DepositRecheckError | typeof DepositsFallbackError} ErrorClass Classe de erro da rota atual.
 * @returns {Promise<{ tenant: Record<string, unknown>, db: import("@cloudflare/workers-types").D1Database, runtimeConfig: Record<string, unknown>, eulenApiToken: string }>} Dependencias prontas.
 */
async function resolveReconciliationRouteContext(c, authorizationLogMessage, dependencyError, ErrorClass) {
  const tenant = c.get("tenant");
  const db = c.get("db");
  const runtimeConfig = c.get("runtimeConfig");

  if (!tenant) {
    throw new ErrorClass(404, "tenant_not_resolved", "Tenant context is required for this operation.");
  }

  const authContext = await authorizeOpsRoute({
    env: c.env,
    runtimeConfig,
    authorizationHeader: c.req.header("authorization"),
    requestId: c.get("requestId"),
    tenant,
    tenantId: tenant.tenantId,
    path: c.req.path,
  });

  log(runtimeConfig, {
    level: "info",
    message: authorizationLogMessage,
    tenantId: tenant.tenantId,
    requestId: c.get("requestId"),
    details: {
      path: c.req.path,
      authScope: authContext.authScope,
      bindingName: authContext.bindingName,
    },
  });

  if (!db) {
    throw new Error("Database binding is required to process operational reconciliation.");
  }

  try {
    return {
      tenant,
      db,
      runtimeConfig,
      eulenApiToken: await readTenantSecret(c.env, tenant, "eulenApiToken"),
    };
  } catch (error) {
    throw new ErrorClass(
      503,
      dependencyError.code,
      dependencyError.message,
      {
        cause: error instanceof Error ? error.message : String(error),
      },
      error,
    );
  }
}

/**
 * Executa o recheck operacional de um deposito via `deposit-status`.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} Resultado da reconciliacao.
 */
export async function handleDepositRecheck(c) {
  try {
    const { tenant, db, runtimeConfig, eulenApiToken } = await resolveReconciliationRouteContext(
      c,
      "ops.deposit_recheck.authorized",
      {
        code: "recheck_dependency_unavailable",
        message: "Required Eulen recheck dependencies are not available for this tenant.",
      },
      DepositRecheckError,
    );

    const result = await processDepositRecheck({
      db,
      runtimeConfig,
      tenant,
      eulenApiToken,
      rawBody: await c.req.text(),
      requestId: c.get("requestId"),
    });

    return c.json(
      {
        ok: true,
        requestId: c.get("requestId"),
        tenantId: tenant.tenantId,
        ...result.details,
      },
      result.status,
    );
  } catch (error) {
    return handleReconciliationRouteError(c, error, {
      authorizationFailed: "ops.deposit_recheck.authorization_failed",
      operationFailed: "ops.deposit_recheck.failed",
    });
  }
}

/**
 * Executa fallback operacional por janela via `/deposits`.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} Resultado da reconciliacao por janela.
 */
export async function handleDepositsFallback(c) {
  try {
    const { tenant, db, runtimeConfig, eulenApiToken } = await resolveReconciliationRouteContext(
      c,
      "ops.deposits_fallback.authorized",
      {
        code: "deposits_fallback_dependency_unavailable",
        message: "Required Eulen deposits fallback dependencies are not available for this tenant.",
      },
      DepositsFallbackError,
    );
    const result = await processDepositsFallback({
      db,
      runtimeConfig,
      tenant,
      eulenApiToken,
      rawBody: await c.req.text(),
      requestId: c.get("requestId"),
    });

    return c.json(
      {
        ok: true,
        requestId: c.get("requestId"),
        tenantId: tenant.tenantId,
        ...result.details,
      },
      result.status,
    );
  } catch (error) {
    return handleReconciliationRouteError(c, error, {
      authorizationFailed: "ops.deposits_fallback.authorization_failed",
      operationFailed: "ops.deposits_fallback.failed",
    });
  }
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
opsRouter.post("/:tenantId/reconcile/deposits", handleDepositsFallback);
opsRouter.get("/:tenantId/telegram/webhook-info", handleTelegramWebhookInfo);
opsRouter.post("/:tenantId/telegram/register-webhook", handleTelegramWebhookRegistration);
opsRouter.get("/:tenantId/eulen/ping", handleEulenPing);
opsRouter.post("/:tenantId/eulen/create-deposit", handleEulenCreateDeposit);
