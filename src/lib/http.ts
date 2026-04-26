/**
 * Utilitarios HTTP compartilhados pela aplicacao.
 *
 * Este arquivo padroniza respostas de erro e respostas de capacidade ainda nao
 * implementada, mantendo a API do Worker consistente desde a primeira entrega
 * do projeto.
 */
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../types/runtime";

export type JsonErrorDetails = Record<string, unknown> | undefined;

export type JsonErrorBody = {
  error: {
    code: string;
    message: string;
    details?: JsonErrorDetails;
  };
  requestId: string;
};

export function jsonError(
  c: AppContext,
  status: number,
  code: string,
  message: string,
  details?: JsonErrorDetails,
): Response {
  return c.json(
    {
      error: {
        code,
        message,
        details,
      },
      requestId: c.get("requestId"),
    },
    status as ContentfulStatusCode,
  );
}

export function jsonNotImplemented(c: AppContext, capability: string, details?: JsonErrorDetails): Response {
  return jsonError(
    c,
    501,
    "feature_not_implemented",
    `${capability} is not implemented yet in this phase of the MVP.`,
    details,
  );
}

export function normalizeHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) {
    return error;
  }

  return new HTTPException(500, {
    message: error instanceof Error ? error.message : "Unexpected internal error",
  });
}
