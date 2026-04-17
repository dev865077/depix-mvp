/**
 * Rotas operacionais internas.
 *
 * Estas rotas servem para reconciliacao e suporte manual. Elas tambem seguem o
 * mesmo modelo de tenant no path para impedir consultas acidentais cruzadas.
 */
import { Hono } from "hono";

import { jsonNotImplemented } from "../lib/http.js";

export const opsRouter = new Hono();

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

// O recheck fica isolado por tenant para alinhar o fallback com o mesmo
// escopo do webhook principal.
opsRouter.post("/:tenantId/recheck/deposit", handleDepositRecheck);
