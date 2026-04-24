/**
 * Middleware responsavel por contexto de requisicao.
 *
 * Este middleware cria o requestId, mede a duracao de cada chamada, le a
 * configuracao segura do runtime, resolve o tenant atual e adiciona logs
 * estruturados para todas as rotas do Worker.
 */
import { HTTPException } from "hono/http-exception";
import { readRuntimeConfig } from "../config/runtime.js";
import { resolveTenantFromRequest, resolveTenantIdFromPath } from "../config/tenants.js";
import { getDatabase } from "../db/client.js";
import { log } from "../lib/logger.js";

import type { Next } from "hono";
import type { AppContext } from "../types/runtime.js";

/**
 * @param {AppContext} c
 * @param {Next} next
 * @returns {Promise<void>}
 */
export async function requestContextMiddleware(c: AppContext, next: Next): Promise<void> {
  const requestId = crypto.randomUUID();
  const requestStartedAt = Date.now();
  const runtimeConfig = await readRuntimeConfig(c.env);
  const db = runtimeConfig.database.bindingConfigured ? getDatabase(c.env) : undefined;
  // Primeiro identificamos se a requisicao aponta para algum tenant conhecido.
  // Isso nos permite devolver 404 cedo para evitar processamento em tenant errado.
  const requestedTenantId = resolveTenantIdFromPath(c.req.path) ?? c.req.header("x-tenant-id") ?? undefined;
  const tenant = resolveTenantFromRequest(runtimeConfig, c.req.path, c.req.header("x-tenant-id") ?? undefined);

  if (requestedTenantId && !tenant) {
    throw new HTTPException(404, {
      message: `Unknown tenant: ${requestedTenantId}`,
    });
  }

  c.set("requestId", requestId);
  c.set("requestStartedAt", requestStartedAt);
  c.set("runtimeConfig", runtimeConfig);
  c.set("db", db);
  c.set("tenant", tenant);

  const operationsToValidate = [
    ["ENABLE_OPS_DEPOSIT_RECHECK", runtimeConfig.operations?.depositRecheck],
    ["ENABLE_OPS_DEPOSITS_FALLBACK", runtimeConfig.operations?.depositsFallback],
  ] as const;

  for (const [bindingName, operation] of operationsToValidate) {
    if (operation?.featureFlag.configured && !operation.featureFlag.recognized) {
      log(runtimeConfig, {
        level: "warn",
        message: "config.invalid_boolean_flag",
        tenantId: tenant?.tenantId,
        requestId,
        path: c.req.path,
        details: {
          bindingName,
          rawValue: operation.featureFlag.rawValue,
        },
      });
    }
  }

  if (runtimeConfig.operations?.depositRecheck?.tenantOverrides?.state === "invalid_config") {
    log(runtimeConfig, {
      level: "warn",
      message: "config.deposit_recheck.tenant_override_invalid",
      tenantId: tenant?.tenantId,
      requestId,
      path: c.req.path,
      details: {
        state: runtimeConfig.operations.depositRecheck.tenantOverrides.state,
        invalidTenantOverrideCount: runtimeConfig.operations.depositRecheck.tenantOverrides.invalidCount,
      },
    });
  }

  // A partir daqui toda rota recebe requestId, runtimeConfig, db e tenant
  // de forma consistente, evitando que cada handler replique esta montagem.
  log(runtimeConfig, {
    level: "info",
    message: "request.received",
    tenantId: tenant?.tenantId,
    requestId,
    method: c.req.method,
    path: c.req.path,
  });

  await next();

  // O requestId volta no header para facilitar suporte, correlacao de logs
  // e depuracao de chamadas vindas do Telegram, Eulen ou operacao manual.
  c.header("x-request-id", requestId);

  log(runtimeConfig, {
    level: "info",
    message: "request.completed",
    tenantId: tenant?.tenantId,
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - requestStartedAt,
  });
}
