/**
 * Middleware responsavel por contexto de requisicao.
 *
 * Este middleware cria o requestId, mede a duracao de cada chamada, le a
 * configuracao segura do runtime e adiciona logs estruturados para todas as
 * rotas do Worker.
 */
import { readRuntimeConfig } from "../config/runtime.js";
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

  c.set("requestId", requestId);
  c.set("requestStartedAt", requestStartedAt);
  c.set("runtimeConfig", runtimeConfig);

  // A partir daqui toda rota recebe requestId e runtimeConfig de forma
  // consistente, evitando que cada handler replique esta montagem.
  log(runtimeConfig, {
    level: "info",
    message: "request.received",
    requestId,
    method: c.req.method,
    path: c.req.path,
  });

  await next();

  // O requestId volta no header para facilitar suporte, correlacao de logs
  // e depuracao de chamadas ao Worker.
  c.header("x-request-id", requestId);

  log(runtimeConfig, {
    level: "info",
    message: "request.completed",
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - requestStartedAt,
  });
}
