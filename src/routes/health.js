/**
 * Rotas de healthcheck.
 */
import { Hono } from "hono";

export const healthRouter = new Hono();

export function handleHealth(c) {
  const runtimeConfig = c.get("runtimeConfig");

  return c.json({
    status: "ok",
    service: runtimeConfig.appName,
    environment: runtimeConfig.environment,
    requestId: c.get("requestId"),
    timestamp: new Date().toISOString(),
    configuration: {
      eulenApiBaseUrl: runtimeConfig.eulenApiBaseUrl,
      database: runtimeConfig.database,
      tenants: runtimeConfig.tenants,
      secrets: runtimeConfig.secrets,
    },
  });
}

healthRouter.get("/", handleHealth);
