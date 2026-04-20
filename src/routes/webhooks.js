/**
 * Rotas de webhooks externos.
 *
 * Aqui ficam as entradas vindas de sistemas terceiros, especialmente a Eulen.
 * O objetivo e manter o tenant explicitamente identificado desde a URL.
 */
import { Hono } from "hono";

import { readTenantSecret } from "../config/tenants.js";
import { jsonError } from "../lib/http.js";
import { processEulenDepositWebhook } from "../services/eulen-deposit-webhook.js";
import { notifyTelegramOrderTransition } from "../services/telegram-payment-notifications.js";

export const webhooksRouter = new Hono();

/**
 * Placeholder do webhook principal de confirmacao de deposito da Eulen.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} Resposta operacional do webhook.
 */
export async function handleEulenDepositWebhook(c) {
  const tenant = c.get("tenant");
  const db = c.get("db");
  const runtimeConfig = c.get("runtimeConfig");

  if (!tenant) {
    return jsonError(c, 404, "tenant_not_resolved", "Tenant context is required for this webhook.");
  }

  if (!db) {
    throw new Error("Database binding is required to process the Eulen webhook.");
  }

  let eulenApiToken;
  let expectedSecret;

  try {
    [eulenApiToken, expectedSecret] = await Promise.all([
      readTenantSecret(c.env, tenant, "eulenApiToken"),
      readTenantSecret(c.env, tenant, "eulenWebhookSecret"),
    ]);
  } catch (error) {
    return jsonError(
      c,
      503,
      "webhook_dependency_unavailable",
      "Required Eulen webhook dependencies are not available for this tenant.",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const result = await processEulenDepositWebhook({
    db,
    runtimeConfig,
    tenant,
    eulenApiToken,
    authorizationHeader: c.req.header("authorization"),
    expectedSecret,
    rawBody: await c.req.text(),
    requestId: c.get("requestId"),
  });

  if (!result.ok) {
    return jsonError(c, result.status, result.code, result.message, result.details);
  }

  await notifyTelegramOrderTransition({
    env: c.env,
    db,
    runtimeConfig,
    tenant,
    requestContext: {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
    },
    ...result.details,
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
}

// Este path foi escolhido como borda canonica do webhook por tenant.
webhooksRouter.post("/eulen/:tenantId/deposit", handleEulenDepositWebhook);
