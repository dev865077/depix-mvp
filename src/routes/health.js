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
      tenants: {
        configured: Object.keys(runtimeConfig.tenants).length > 0,
        count: Object.keys(runtimeConfig.tenants).length,
      },
      secrets: runtimeConfig.secrets,
      operations: {
        depositRecheck: {
          state: runtimeConfig.operations.depositRecheck.state,
          ready: runtimeConfig.operations.depositRecheck.ready,
          tenantOverrides: runtimeConfig.operations.depositRecheck.tenantOverrides,
        },
      },
    },
  });
}

healthRouter.get("/", handleHealth);
