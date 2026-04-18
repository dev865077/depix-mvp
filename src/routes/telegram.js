/**
 * Rotas do Telegram.
 *
 * Mesmo antes da entrada do grammY, este modulo ja materializa a superficie
 * multi-tenant que o Worker vai expor para cada bot parceiro.
 */
import { Hono } from "hono";

import { readSecretBindingValue } from "../config/tenants.js";
import { log } from "../lib/logger.js";
import { getTelegramRuntime } from "../telegram/runtime.js";

export const telegramRouter = new Hono();

/**
 * Encaminha o webhook do Telegram para o runtime real do grammY.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Promise<Response>} Resposta produzida pelo grammY.
 */
export async function handleTelegramWebhook(c) {
  const tenant = c.get("tenant");
  const runtimeConfig = c.get("runtimeConfig");

  if (!tenant) {
    throw new Error("Telegram webhook requires a resolved tenant.");
  }

  const telegramRuntime = getTelegramRuntime(tenant);
  const telegramBotToken = await readSecretBindingValue(c.env, tenant.secretBindings.telegramBotToken);
  const webhookHandler = telegramRuntime.createWebhookCallback(telegramBotToken);

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

  const response = await webhookHandler(c.req.raw);

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
