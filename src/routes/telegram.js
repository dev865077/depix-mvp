/**
 * Rotas do Telegram.
 *
 * Mesmo antes da entrada do grammY, este modulo ja materializa a superficie
 * multi-tenant que o Worker vai expor para cada bot parceiro.
 */
import { Hono } from "hono";

import { jsonNotImplemented } from "../lib/http.js";
import { getTelegramRuntime } from "../telegram/runtime.js";

export const telegramRouter = new Hono();

/**
 * Placeholder do webhook do Telegram.
 *
 * O handler ja recebe o tenant resolvido pelo middleware para que a camada
 * futura do bot nao precise redescobrir de qual parceiro veio a chamada.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * Nesta issue o webhook ainda nao processa updates. Mesmo assim, ele ja
 * materializa o runtime do `grammY` para o tenant atual, deixando a proxima
 * issue livre para focar apenas na execucao do webhook real.
 *
 * @returns {Response} Resposta 501 padronizada.
 */
export function handleTelegramWebhook(c) {
  const tenant = c.get("tenant");
  const telegramRuntime = tenant ? getTelegramRuntime(tenant) : undefined;

  return jsonNotImplemented(c, "Telegram webhook", {
    tenantId: tenant?.tenantId,
    tenantDisplayName: tenant?.displayName,
    telegramRuntime: telegramRuntime?.engine,
  });
}

// O tenant fica no path para evitar ambiguidade operacional e simplificar
// configuracao de webhook por bot.
telegramRouter.post("/:tenantId/webhook", handleTelegramWebhook);
