/**
 * Rotas do Telegram.
 *
 * Mesmo antes da entrada do grammY, este modulo ja materializa a superficie
 * multi-tenant que o Worker vai expor para cada bot parceiro.
 */
import { Hono } from "hono";

import { jsonNotImplemented } from "../lib/http.js";

export const telegramRouter = new Hono();

/**
 * Placeholder do webhook do Telegram.
 *
 * O handler ja recebe o tenant resolvido pelo middleware para que a camada
 * futura do bot nao precise redescobrir de qual parceiro veio a chamada.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Response} Resposta 501 padronizada.
 */
export function handleTelegramWebhook(c) {
  const tenant = c.get("tenant");

  return jsonNotImplemented(c, "Telegram webhook", {
    tenantId: tenant?.tenantId,
    tenantDisplayName: tenant?.displayName,
  });
}

// O tenant fica no path para evitar ambiguidade operacional e simplificar
// configuracao de webhook por bot.
telegramRouter.post("/:tenantId/webhook", handleTelegramWebhook);
