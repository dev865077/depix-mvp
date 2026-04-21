import type { Context } from "hono";
import type { TenantId } from "./domain";
import { readRuntimeConfig } from "../config/runtime.js";
import { resolveTenantFromRequest } from "../config/tenants.js";

export interface TenantSecretBindings {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  eulenApiToken: string;
  eulenWebhookSecret: string;
}

export interface TenantSplitConfigBindings {
  depixSplitAddress: string;
  splitFee: string;
}

export interface TenantOpsBindings {
  depositRecheckBearerToken?: string;
}

export interface TenantConfig {
  tenantId: TenantId;
  displayName: string;
  eulenPartnerId?: string;
  splitConfigBindings: TenantSplitConfigBindings;
  opsBindings: TenantOpsBindings;
  secretBindings: TenantSecretBindings;
}

export type TenantRegistry = Record<TenantId, TenantConfig>;

type RuntimeConfig = ReturnType<typeof readRuntimeConfig>;
type ResolvedTenant = ReturnType<typeof resolveTenantFromRequest>;

export interface WorkerEnv {
  APP_NAME: string;
  APP_ENV: "local" | "test" | "production";
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  EULEN_API_BASE_URL: string;
  EULEN_API_TIMEOUT_MS: string;
  TENANT_REGISTRY: string;
  DB: D1Database;
  [bindingName: string]: unknown;
}

export interface AppVariables {
  requestId: string;
  requestStartedAt: number;
  runtimeConfig: RuntimeConfig;
  db: D1Database | undefined;
  tenant: ResolvedTenant;
}

export type AppContext = Context<{ Bindings: WorkerEnv; Variables: AppVariables }>;
