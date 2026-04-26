/**
 * Leitura e saneamento da configuracao de runtime do Worker.
 *
 * Este modulo concentra as regras de ambiente do projeto. Ele valida bindings
 * obrigatorios, diferencia local/test/production e devolve apenas um resumo
 * seguro da configuracao, sem nunca expor valores sensiveis.
 */
import { readTenantRegistryFromKv } from "./tenants.js";
import type { TenantRegistry } from "./tenants.js";
import { readTelegramOpenOrderTimeoutMinutes } from "../services/telegram-conversation-timeout.js";

type AppEnvironment = "local" | "test" | "production";
type LogLevel = "debug" | "info" | "warn" | "error";
type OpsRouteState = "ready" | "disabled" | "invalid_config" | "missing_secret";
type ScheduledReconciliationState = "ready" | "disabled" | "invalid_config" | "missing_database" | "missing_secret";
type BooleanFlagState = Readonly<{
  configured: boolean;
  recognized: boolean;
  rawValue: string | null;
}>;
type SecretStoreBinding = Readonly<{
  get: () => Promise<unknown>;
}>;
type RuntimeEnv = Record<string, unknown>;

const APP_ENVIRONMENTS = new Set(["local", "test", "production"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const TRUE_BOOLEAN_BINDING_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_BOOLEAN_BINDING_VALUES = new Set(["false", "0", "no", "off", ""]);

/**
 * Indica se um binding secreto esta materialmente configurado no runtime.
 *
 * Para strings locais exigimos conteudo nao vazio. Para Secrets Store, a
 * presenca do objeto com `get()` ja indica que o binding foi provisionado.
 *
 * @param {unknown} binding Binding bruto no env.
 * @returns {boolean} Verdadeiro quando o binding existe de forma utilizavel.
 */
function isSecretStoreBinding(binding: unknown): binding is SecretStoreBinding {
  return Boolean(binding && typeof binding === "object" && "get" in binding && typeof binding.get === "function");
}

function readOptionalStringBinding(env: RuntimeEnv, key: string): string | undefined {
  const value = env[key];

  return typeof value === "string" ? value : undefined;
}

function isSecretBindingConfigured(binding: unknown): boolean {
  if (typeof binding === "string") {
    return binding.trim().length > 0;
  }

  return isSecretStoreBinding(binding);
}

/**
 * Conta overrides tenant-scoped declarados sem binding valido.
 *
 * Este sinal e deliberadamente separado da prontidao global. Um tenant com
 * override quebrado deve falhar fechado apenas naquele tenant, sem transformar
 * a rota inteira em indisponivel para tenants que continuam saudaveis.
 *
 * @param {Record<string, unknown>} env Bindings atuais.
 * @param {Record<string, { opsBindings?: { depositRecheckBearerToken?: string } }>} tenants Registro de tenants.
 * @returns {number} Quantidade de overrides declarados sem segredo valido.
 */
function countInvalidTenantScopedDepositRecheckOverrides(env: RuntimeEnv, tenants: TenantRegistry): number {
  return Object.values(tenants).filter((tenant) => {
    const bindingName = tenant.opsBindings?.depositRecheckBearerToken;

    if (!bindingName) {
      return false;
    }

    return !isSecretBindingConfigured(env[bindingName]);
  }).length;
}

/**
 * Resume um estado operacional redigido para uma rota operacional.
 *
 * O objetivo e dar sinal claro para operadores em `/health` sem expor nomes de
 * bindings, inventario de tenants ou valores crus de configuracao sensivel.
 *
 * @param {{ configured: boolean, recognized: boolean }} featureFlag Estado da flag textual.
 * @param {boolean} enabled Resultado booleano ja normalizado para a flag.
 * @param {boolean} globalBearerBindingConfigured Se o token global existe no ambiente.
 * @returns {"ready" | "disabled" | "invalid_config" | "missing_secret"} Estado global redigido.
 */
export function describeOpsRouteState(
  featureFlag: BooleanFlagState,
  enabled: boolean,
  globalBearerBindingConfigured: boolean,
): OpsRouteState {
  if (featureFlag.configured && !featureFlag.recognized) {
    return "invalid_config";
  }

  if (!enabled) {
    return "disabled";
  }

  if (!globalBearerBindingConfigured) {
    return "missing_secret";
  }

  return "ready";
}

export const describeDepositRecheckState = describeOpsRouteState;

/**
 * Resume o estado operacional da reconciliacao agendada.
 *
 * Diferente das rotas `/ops`, o cron nao depende de bearer HTTP. Ele precisa
 * apenas de flag explicita, D1 e bindings secretos dos tenants para consultar
 * a Eulen de forma tenant-scoped.
 *
 * @param {{ configured: boolean, recognized: boolean }} featureFlag Estado da flag textual.
 * @param {boolean} enabled Resultado booleano ja normalizado para a flag.
 * @param {boolean} databaseBindingConfigured Se o D1 existe no ambiente.
 * @param {boolean} tenantSecretBindingsConfigured Se os tenants declaram os bindings obrigatorios.
 * @returns {"ready" | "disabled" | "invalid_config" | "missing_database" | "missing_secret"} Estado global redigido.
 */
export function describeScheduledDepositReconciliationState(
  featureFlag: BooleanFlagState,
  enabled: boolean,
  databaseBindingConfigured: boolean,
  tenantSecretBindingsConfigured: boolean,
): ScheduledReconciliationState {
  if (featureFlag.configured && !featureFlag.recognized) {
    return "invalid_config";
  }

  if (!enabled) {
    return "disabled";
  }

  if (!databaseBindingConfigured) {
    return "missing_database";
  }

  if (!tenantSecretBindingsConfigured) {
    return "missing_secret";
  }

  return "ready";
}

/**
 * Normaliza uma flag textual de runtime.
 *
 * Flags de operacao ficam em `vars`, nao em codigo. Esta funcao trata ausencia
 * e valores desconhecidos como `false`, aceitando aliases operacionais comuns
 * para evitar que um typo ou legado de deploy derrube o Worker inteiro.
 *
 * @param {string | undefined} value Valor bruto vindo do runtime.
 * @param {string} key Nome do binding para mensagens de erro.
 * @returns {boolean} Flag normalizada.
 */
export function readBooleanFlag(value: string | undefined, key: string): boolean {
  if (typeof value === "undefined") {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (TRUE_BOOLEAN_BINDING_VALUES.has(normalizedValue)) {
    return true;
  }

  if (FALSE_BOOLEAN_BINDING_VALUES.has(normalizedValue)) {
    return false;
  }

  return false;
}

/**
 * Descreve o estado operacional de uma flag textual sem expor segredo algum.
 *
 * Isso permite que `/health` revele se uma feature esta habilitada, ausente ou
 * com valor desconhecido, sem transformar erro de configuracao em boot failure.
 *
 * @param {string | undefined} value Valor bruto do runtime.
 * @returns {{ configured: boolean, recognized: boolean, rawValue: string | null }}
 */
export function describeBooleanFlagState(value: string | undefined): BooleanFlagState {
  if (typeof value === "undefined") {
    return {
      configured: false,
      recognized: false,
      rawValue: null,
    };
  }

  const normalizedValue = value.trim().toLowerCase();

  return {
    configured: true,
    recognized: TRUE_BOOLEAN_BINDING_VALUES.has(normalizedValue)
      || FALSE_BOOLEAN_BINDING_VALUES.has(normalizedValue),
    rawValue: normalizedValue,
  };
}

/**
 * Garante que um binding textual obrigatorio exista e tenha conteudo.
 *
 * @param {string | undefined} value Valor bruto vindo do runtime.
 * @param {string} key Nome do binding para mensagem de erro.
 * @returns {string} Valor validado.
 */
export function assertRequiredString(value: string | undefined, key: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required binding: ${key}`);
  }

  return value;
}

/**
 * Converte um binding textual em inteiro positivo para uso operacional.
 *
 * @param {string | undefined} value Valor bruto vindo do runtime.
 * @param {string} key Nome do binding para mensagem de erro.
 * @returns {number} Numero inteiro positivo.
 */
export function assertPositiveInteger(value: string | undefined, key: string): number {
  const parsedValue = Number.parseInt(assertRequiredString(value, key), 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid positive integer binding: ${key}`);
  }

  return parsedValue;
}

/**
 * Le o conjunto de bindings do Worker e devolve um runtime seguro e tipado.
 *
 * Este objeto e a "fonte da verdade" em memoria para:
 * - ambiente atual
 * - configuracao HTTP/Eulen
 * - tenants registrados
 * - indicadores de bindings sensiveis configurados
 *
 * @param {Record<string, unknown>} env Bindings recebidos do Worker.
 * @returns {{
 *   appName: string,
 *   environment: "local" | "test" | "production",
 *   logLevel: "debug" | "info" | "warn" | "error",
 *   eulenApiBaseUrl: string,
 *   eulenApiTimeoutMs: number,
 *   financialApiBaseUrl: string,
 *   telegramOpenOrderTimeoutMinutes: number,
 *   database: {
 *     bindingConfigured: boolean
 *   },
 *   tenants: Record<string, {
 *     tenantId: string,
 *     displayName: string,
 *     eulenPartnerId?: string,
 *     splitConfigBindings: {
 *       depixSplitAddress: string,
 *       splitFee: string
 *     },
 *     opsBindings: {
 *       depositRecheckBearerToken?: string
 *     },
 *     secretBindings: Record<string, string>
 *   }>,
 *   secrets: {
 *     registryConfigured: boolean,
 *     tenantSecretBindingsConfigured: boolean
 *   },
 *   operations: {
 *     depositRecheck: {
 *       enabled: boolean,
 *       featureFlag: {
 *         configured: boolean,
 *         recognized: boolean,
 *         rawValue: string | null
 *       },
 *       state: "ready" | "disabled" | "invalid_config" | "missing_secret",
 *       ready: boolean,
 *       globalBearerBindingConfigured: boolean,
 *       tenantOverrides: {
 *         state: "ready" | "invalid_config",
 *         invalidCount: number
 *       }
 *     },
 *     depositsFallback: {
 *       enabled: boolean,
 *       featureFlag: {
 *         configured: boolean,
 *         recognized: boolean,
 *         rawValue: string | null
 *       },
 *       state: "ready" | "disabled" | "invalid_config" | "missing_secret",
 *       ready: boolean,
 *       globalBearerBindingConfigured: boolean,
 *       tenantOverrides: {
 *         state: "ready" | "invalid_config",
 *         invalidCount: number
 *       }
 *     },
 *     scheduledDepositReconciliation: {
 *       enabled: boolean,
 *       featureFlag: {
 *         configured: boolean,
 *         recognized: boolean,
 *         rawValue: string | null
 *       },
 *       state: "ready" | "disabled" | "invalid_config" | "missing_database" | "missing_secret",
 *       ready: boolean
 *     }
 *   }
 * }} Configuracao consolidada do runtime.
 */
export async function readRuntimeConfig(env: RuntimeEnv) {
  const appName = assertRequiredString(readOptionalStringBinding(env, "APP_NAME"), "APP_NAME");
  const rawEnvironment = assertRequiredString(readOptionalStringBinding(env, "APP_ENV"), "APP_ENV");
  const rawLogLevel = assertRequiredString(readOptionalStringBinding(env, "LOG_LEVEL"), "LOG_LEVEL");
  const eulenApiBaseUrl = assertRequiredString(readOptionalStringBinding(env, "EULEN_API_BASE_URL"), "EULEN_API_BASE_URL");
  const eulenApiTimeoutMs = assertPositiveInteger(readOptionalStringBinding(env, "EULEN_API_TIMEOUT_MS"), "EULEN_API_TIMEOUT_MS");
  const financialApiBaseUrl = assertRequiredString(
    readOptionalStringBinding(env, "FINANCIAL_API_BASE_URL"),
    "FINANCIAL_API_BASE_URL",
  );
  const telegramOpenOrderTimeoutMinutes = readTelegramOpenOrderTimeoutMinutes(
    readOptionalStringBinding(env, "TELEGRAM_OPEN_ORDER_TIMEOUT_MINUTES"),
  );

  if (!APP_ENVIRONMENTS.has(rawEnvironment)) {
    throw new Error(`Invalid APP_ENV value: ${rawEnvironment}`);
  }

  if (!LOG_LEVELS.has(rawLogLevel)) {
    throw new Error(`Invalid LOG_LEVEL value: ${rawLogLevel}`);
  }

  const tenants = await readTenantRegistryFromKv(env);
  const hasTenantSecretBindings = Object.values(tenants).every((tenant) => (
    Object.values(tenant.secretBindings).every(Boolean)
    && Object.values(tenant.splitConfigBindings).every(Boolean)
  ));
  const environment = rawEnvironment as AppEnvironment;
  const logLevel = rawLogLevel as LogLevel;
  const depositRecheckBinding = readOptionalStringBinding(env, "ENABLE_OPS_DEPOSIT_RECHECK");
  const depositsFallbackBinding = readOptionalStringBinding(env, "ENABLE_OPS_DEPOSITS_FALLBACK");
  const scheduledDepositReconciliationBinding = readOptionalStringBinding(
    env,
    "ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION",
  );
  const depositRecheckEnabled = readBooleanFlag(depositRecheckBinding, "ENABLE_OPS_DEPOSIT_RECHECK");
  const depositRecheckFlagState = describeBooleanFlagState(depositRecheckBinding);
  const depositsFallbackEnabled = readBooleanFlag(
    depositsFallbackBinding,
    "ENABLE_OPS_DEPOSITS_FALLBACK",
  );
  const depositsFallbackFlagState = describeBooleanFlagState(depositsFallbackBinding);
  const scheduledDepositReconciliationEnabled = readBooleanFlag(
    scheduledDepositReconciliationBinding,
    "ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION",
  );
  const scheduledDepositReconciliationFlagState = describeBooleanFlagState(
    scheduledDepositReconciliationBinding,
  );
  const databaseBindingConfigured = Boolean(env.DB);
  const globalBearerBindingConfigured = isSecretBindingConfigured(env.OPS_ROUTE_BEARER_TOKEN);
  const invalidTenantOverrideCount = countInvalidTenantScopedDepositRecheckOverrides(env, tenants);
  const depositRecheckState = describeOpsRouteState(
    depositRecheckFlagState,
    depositRecheckEnabled,
    globalBearerBindingConfigured,
  );
  const depositsFallbackState = describeOpsRouteState(
    depositsFallbackFlagState,
    depositsFallbackEnabled,
    globalBearerBindingConfigured,
  );
  const scheduledDepositReconciliationState = describeScheduledDepositReconciliationState(
    scheduledDepositReconciliationFlagState,
    scheduledDepositReconciliationEnabled,
    databaseBindingConfigured,
    hasTenantSecretBindings,
  );

  return {
    appName,
    environment,
    logLevel,
    eulenApiBaseUrl,
    eulenApiTimeoutMs,
    financialApiBaseUrl,
    telegramOpenOrderTimeoutMinutes,
    database: {
      bindingConfigured: databaseBindingConfigured,
    },
    tenants,
    secrets: {
      registryConfigured: true,
      tenantSecretBindingsConfigured: hasTenantSecretBindings,
    },
    operations: {
      depositRecheck: {
        enabled: depositRecheckEnabled,
        featureFlag: depositRecheckFlagState,
        state: depositRecheckState,
        ready: depositRecheckState === "ready",
        globalBearerBindingConfigured,
        tenantOverrides: {
          state: invalidTenantOverrideCount > 0 ? "invalid_config" : "ready",
          invalidCount: invalidTenantOverrideCount,
        },
      },
      depositsFallback: {
        enabled: depositsFallbackEnabled,
        featureFlag: depositsFallbackFlagState,
        state: depositsFallbackState,
        ready: depositsFallbackState === "ready",
        globalBearerBindingConfigured,
        tenantOverrides: {
          state: invalidTenantOverrideCount > 0 ? "invalid_config" : "ready",
          invalidCount: invalidTenantOverrideCount,
        },
      },
      scheduledDepositReconciliation: {
        enabled: scheduledDepositReconciliationEnabled,
        featureFlag: scheduledDepositReconciliationFlagState,
        state: scheduledDepositReconciliationState,
        ready: scheduledDepositReconciliationState === "ready",
      },
    },
  };
}
