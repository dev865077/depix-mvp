/**
 * Rotas de healthcheck.
 */
import { Hono } from "hono";

import type { AppBindings, AppContext } from "../types/runtime";

type HealthTenant = AppContext["var"]["runtimeConfig"]["tenants"][string];

type HealthTenantInventory = Record<string, {
  tenantId: string;
  displayName: string;
  eulenPartnerConfigured: boolean;
  splitConfigConfigured: boolean;
  secretBindingsConfigured: boolean;
  opsDepositRecheckOverrideConfigured: boolean;
}>;

export const healthRouter = new Hono<AppBindings>();

/**
 * Monta a versao publica do inventario de tenants exposto pelo healthcheck.
 *
 * O `runtimeConfig.tenants` e uma estrutura interna: alem de metadados de
 * exibicao, ele carrega nomes de bindings que apontam para segredos, split
 * config e tokens operacionais. Esses nomes nao sao o valor secreto, mas ainda
 * descrevem a topologia operacional do deploy. O healthcheck deve confirmar
 * que o tenant existe sem publicar essa topologia.
 *
 * @param {Record<string, {
 *   tenantId: string,
 *   displayName: string,
 *   eulenPartnerId?: string,
 *   splitConfigBindings?: Record<string, string>,
 *   opsBindings?: Record<string, string>,
 *   secretBindings?: Record<string, string>
 * }>} tenants Registro interno normalizado.
 * @returns {Record<string, {
 *   tenantId: string,
 *   displayName: string,
 *   eulenPartnerConfigured: boolean,
 *   splitConfigConfigured: boolean,
 *   secretBindingsConfigured: boolean,
 *   opsDepositRecheckOverrideConfigured: boolean
 * }>} Inventario seguro para resposta HTTP.
 */
export function redactTenantsForHealth(tenants: Record<string, HealthTenant>): HealthTenantInventory {
  return Object.fromEntries(
    Object.entries(tenants).map(([tenantId, tenant]) => [
      tenantId,
      {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        eulenPartnerConfigured: typeof tenant.eulenPartnerId === "string" && tenant.eulenPartnerId.length > 0,
        splitConfigConfigured: Object.keys(tenant.splitConfigBindings ?? {}).length > 0,
        secretBindingsConfigured: Object.keys(tenant.secretBindings ?? {}).length > 0,
        opsDepositRecheckOverrideConfigured:
          typeof tenant.opsBindings?.depositRecheckBearerToken === "string"
          && tenant.opsBindings.depositRecheckBearerToken.length > 0,
      },
    ]),
  );
}

export function handleHealth(c: AppContext): Response {
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
      tenants: redactTenantsForHealth(runtimeConfig.tenants),
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
        depositsFallback: {
          state: runtimeConfig.operations.depositsFallback.state,
          ready: runtimeConfig.operations.depositsFallback.ready,
          tenantOverrides: runtimeConfig.operations.depositsFallback.tenantOverrides,
        },
        scheduledDepositReconciliation: {
          state: runtimeConfig.operations.scheduledDepositReconciliation.state,
          ready: runtimeConfig.operations.scheduledDepositReconciliation.ready,
        },
      },
    },
  });
}

healthRouter.get("/", handleHealth);
