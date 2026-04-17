/**
 * Utilitarios HTTP compartilhados pela aplicacao.
 *
 * Este arquivo padroniza respostas de erro e respostas de capacidade ainda nao
 * implementada, mantendo a API do Worker consistente desde a primeira entrega
 * do projeto.
 */
import { HTTPException } from "hono/http-exception";

export function jsonError(c, status, code, message, details) {
  return c.json(
    {
      error: {
        code,
        message,
        details,
      },
      requestId: c.get("requestId"),
      tenantId: c.get("tenant")?.tenantId,
    },
    status,
  );
}

export function jsonNotImplemented(c, capability, details) {
  return jsonError(
    c,
    501,
    "feature_not_implemented",
    `${capability} is not implemented yet in this phase of the MVP.`,
    details,
  );
}

export function normalizeHttpError(error) {
  if (error instanceof HTTPException) {
    return error;
  }

  return new HTTPException(500, {
    message: error instanceof Error ? error.message : "Unexpected internal error",
  });
}
