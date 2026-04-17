/**
 * Rotas de webhooks externos.
 *
 * Aqui ficam as entradas vindas de sistemas terceiros, especialmente a Eulen.
 * O objetivo e manter o tenant explicitamente identificado desde a URL.
 */
import { Hono } from "hono";

import { jsonNotImplemented } from "../lib/http.js";

export const webhooksRouter = new Hono();

/**
 * Placeholder do webhook principal de confirmacao de deposito da Eulen.
 *
 * @param {import("hono").Context} c Contexto HTTP atual.
 * @returns {Response} Resposta 501 padronizada.
 */
export function handleEulenDepositWebhook(c) {
  const tenant = c.get("tenant");

  return jsonNotImplemented(c, "Eulen deposit webhook", {
    tenantId: tenant?.tenantId,
    eulenPartnerId: tenant?.eulenPartnerId,
  });
}

// Este path foi escolhido como borda canonica do webhook por tenant.
webhooksRouter.post("/eulen/:tenantId/deposit", handleEulenDepositWebhook);
