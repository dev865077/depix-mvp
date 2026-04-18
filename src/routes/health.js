/**
 * Rotas de healthcheck.
 */
import { Hono } from "hono";

export const healthRouter = new Hono();

export function handleHealth(c) {
  const runtimeConfig = c.get("runtimeConfig");
  const tenantIds = Object.keys(runtimeConfig.tenants);

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
      tenantSummary: {
        configured: tenantIds.length > 0,
        count: tenantIds.length,
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
