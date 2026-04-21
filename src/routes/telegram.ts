/**
 * Rotas do Telegram.
 *
 * Mesmo antes da entrada do grammY, este modulo ja materializa a superficie
 * multi-tenant que o Worker vai expor para cada bot parceiro.
 */
import { Hono } from "hono";

import { readTenantSecret } from "../config/tenants.js";
import { dispatchNonBlockingTask } from "../lib/background-tasks.js";
import { jsonError } from "../lib/http.js";
import { log } from "../lib/logger.js";
import { ensureTelegramWebhookPublicSurface } from "../services/telegram-webhook-ops.js";
import { normalizeTelegramWebhookError } from "../telegram/errors.js";
import { parseTelegramRawUpdateEnvelope } from "../telegram/raw-update.js";
import { getTelegramRuntime } from "../telegram/runtime.js";
import type { AppBindings, AppContext } from "../types/runtime";

export const telegramRouter = new Hono<AppBindings>();

function shouldEnsureTelegramPublicSurface(runtimeConfig: { environment?: string } | undefined): boolean {
  return runtimeConfig?.environment !== "local";
}

function buildTelegramPublicBaseUrl(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

/**
 * Encaminha o webhook do Telegram para o runtime real do grammY.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} Resposta produzida pelo grammY.
 */
export async function handleTelegramWebhook(c: AppContext): Promise<Response> {
  const tenant = c.get("tenant");
  const runtimeConfig = c.get("runtimeConfig");
  const db = c.get("db");

  if (!tenant) {
    log(runtimeConfig, {
      level: "warn",
      message: "telegram.webhook.ignored",
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: 204,
      details: {
        reason: "tenant_not_resolved",
      },
    });

    c.res = new Response(null, {
      status: 204,
    });

    return c.res;
  }

  const telegramRuntime = getTelegramRuntime(tenant);
  let response: Response;

  try {
    const rawTelegramUpdateBody = await c.req.raw.clone().text();
    const rawTelegramUpdateMetadata = parseTelegramRawUpdateEnvelope(rawTelegramUpdateBody, {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
    }).metadata;
    const [telegramBotToken, telegramWebhookSecret] = await Promise.all([
      readTenantSecret(c.env, tenant, "telegramBotToken"),
      readTenantSecret(c.env, tenant, "telegramWebhookSecret"),
    ]);

    if (shouldEnsureTelegramPublicSurface(runtimeConfig)) {
      await dispatchNonBlockingTask(
        c,
        ensureTelegramWebhookPublicSurface({
          env: c.env,
          tenant,
          environment: runtimeConfig.environment,
          publicBaseUrl: buildTelegramPublicBaseUrl(c.req.url),
          telegramBotToken,
          telegramWebhookSecret,
        }).then((result) => {
          if (!result.repaired && !result.reason) {
            return;
          }

          log(runtimeConfig, {
            level: result.repaired ? "warn" : "info",
            message: "telegram.public_surface.ensure_completed",
            tenantId: tenant.tenantId,
            requestId: c.get("requestId"),
            method: c.req.method,
            path: c.req.path,
            details: result,
          });
        }).catch((error) => {
          log(runtimeConfig, {
            level: "warn",
            message: "telegram.public_surface.ensure_failed",
            tenantId: tenant.tenantId,
            requestId: c.get("requestId"),
            method: c.req.method,
            path: c.req.path,
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }),
      );
    }

    const webhookHandler = telegramRuntime.createWebhookCallback({
      telegramBotToken,
      telegramWebhookSecret,
      env: c.env,
      runtimeConfig,
      db,
      rawTelegramUpdate: rawTelegramUpdateMetadata,
      requestContext: {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
      },
    });

    log(runtimeConfig, {
      level: "info",
      message: "telegram.webhook.dispatching",
      tenantId: tenant.tenantId,
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      details: {
        telegramRuntime: telegramRuntime.engine,
      },
    });

    response = await webhookHandler(c.req.raw);
  } catch (error) {
    const telegramError = normalizeTelegramWebhookError(error);

    log(runtimeConfig, {
      level: "error",
      message: "telegram.webhook.failed",
      tenantId: tenant.tenantId,
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: telegramError.status,
      details: {
        code: telegramError.code,
        ...telegramError.details,
      },
    });

    return jsonError(c, telegramError.status, telegramError.code, telegramError.message, telegramError.details);
  }

  log(runtimeConfig, {
    level: "info",
    message: "telegram.webhook.dispatched",
    tenantId: tenant.tenantId,
    requestId: c.get("requestId"),
    method: c.req.method,
    path: c.req.path,
    status: response.status,
    details: {
      telegramRuntime: telegramRuntime.engine,
    },
  });

  c.res = response;

  return c.res;
}

// O tenant fica no path para evitar ambiguidade operacional e simplificar
// configuracao de webhook por bot.
telegramRouter.post("/:tenantId/webhook", handleTelegramWebhook);
