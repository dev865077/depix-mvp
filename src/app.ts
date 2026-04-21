/**
 * Composicao principal da aplicacao Hono.
 *
 * Este arquivo conecta middleware, tratamento global de erro, rotas minimas do
 * MVP e o redirecionamento da raiz para `/health`. Ele e o coracao da borda
 * HTTP do Worker.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { requestContextMiddleware } from "./middleware/request-context.js";
import { normalizeHttpError, jsonError } from "./lib/http.js";
import { log } from "./lib/logger.js";
import { healthRouter } from "./routes/health.js";
import { telegramRouter } from "./routes/telegram.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { opsRouter } from "./routes/ops.js";
import type { AppBindings, AppContext } from "./types/runtime";

export function logAppError(c: AppContext, httpError: HTTPException): void {
  const runtimeConfig = c.get("runtimeConfig");

  if (!runtimeConfig) {
    return;
  }

  log(runtimeConfig, {
    level: "error",
    message: "request.failed",
    tenantId: c.get("tenant")?.tenantId,
    requestId: c.get("requestId"),
    method: c.req.method,
    path: c.req.path,
    status: httpError.status,
    details: {
      error: httpError.message,
    },
  });
}

export function handleAppError(error: unknown, c: AppContext): Response {
  const httpError = normalizeHttpError(error);

  logAppError(c, httpError);

  return jsonError(c, httpError.status, "request_failed", httpError.message);
}

export function handleNotFound(c: AppContext): Response {
  return jsonError(c, 404, "route_not_found", `No route matches ${c.req.path}`);
}

export function handleRootRedirect(c: AppContext): never {
  throw new HTTPException(302, {
    res: c.redirect("/health"),
  });
}

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", requestContextMiddleware);
  app.onError(handleAppError);
  app.notFound(handleNotFound);

  app.route("/health", healthRouter);
  app.route("/telegram", telegramRouter);
  app.route("/webhooks", webhooksRouter);
  app.route("/ops", opsRouter);
  app.get("/", handleRootRedirect);

  return app;
}
