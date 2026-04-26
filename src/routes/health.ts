/**
 * Rotas de healthcheck.
 */
import { Hono } from "hono";

import type { AppBindings, AppContext } from "../types/runtime";

export const healthRouter = new Hono<AppBindings>();

export function handleHealth(c: AppContext): Response {
  const runtimeConfig = c.get("runtimeConfig");

  return c.json({
    status: "ok",
    service: runtimeConfig.appName,
    environment: runtimeConfig.environment,
    requestId: c.get("requestId"),
    timestamp: new Date().toISOString(),
    configuration: {
      runtime: "product-shell",
      externalSystems: runtimeConfig.externalSystems,
    },
  });
}

healthRouter.get("/", handleHealth);
