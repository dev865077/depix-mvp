/**
 * Leitura e saneamento da configuracao de runtime do Worker.
 *
 * Este modulo concentra as regras de ambiente do projeto. Ele valida bindings
 * obrigatorios, diferencia local/test/production e devolve apenas um resumo
 * seguro da configuracao, sem nunca expor valores sensiveis.
 */
import { readTenantRegistry } from "./tenants.js";

const APP_ENVIRONMENTS = new Set(["local", "test", "production"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

/**
 * Garante que um binding textual obrigatorio exista e tenha conteudo.
 *
 * @param {string | undefined} value Valor bruto vindo do runtime.
 * @param {string} key Nome do binding para mensagem de erro.
 * @returns {string} Valor validado.
 */
export function assertRequiredString(value, key) {
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
export function assertPositiveInteger(value, key) {
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
 * @param {Record<string, string | undefined>} env Bindings recebidos do Worker.
 * @returns {{
 *   appName: string,
 *   environment: "local" | "test" | "production",
 *   logLevel: "debug" | "info" | "warn" | "error",
 *   eulenApiBaseUrl: string,
 *   eulenApiTimeoutMs: number,
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
 *     secretBindings: Record<string, string>
 *   }>,
 *   secrets: {
 *     registryConfigured: boolean,
 *     tenantSecretBindingsConfigured: boolean
 *   }
 * }} Configuracao consolidada do runtime.
 */
export function readRuntimeConfig(env) {
  const appName = assertRequiredString(env.APP_NAME, "APP_NAME");
  const rawEnvironment = assertRequiredString(env.APP_ENV, "APP_ENV");
  const rawLogLevel = assertRequiredString(env.LOG_LEVEL, "LOG_LEVEL");
  const eulenApiBaseUrl = assertRequiredString(env.EULEN_API_BASE_URL, "EULEN_API_BASE_URL");
  const eulenApiTimeoutMs = assertPositiveInteger(env.EULEN_API_TIMEOUT_MS, "EULEN_API_TIMEOUT_MS");

  if (!APP_ENVIRONMENTS.has(rawEnvironment)) {
    throw new Error(`Invalid APP_ENV value: ${rawEnvironment}`);
  }

  if (!LOG_LEVELS.has(rawLogLevel)) {
    throw new Error(`Invalid LOG_LEVEL value: ${rawLogLevel}`);
  }

  const tenants = readTenantRegistry(env);
  const hasTenantSecretBindings = Object.values(tenants).every((tenant) => (
    Object.values(tenant.secretBindings).every(Boolean)
    && Object.values(tenant.splitConfigBindings).every(Boolean)
  ));

  return {
    appName,
    environment: rawEnvironment,
    logLevel: rawLogLevel,
    eulenApiBaseUrl,
    eulenApiTimeoutMs,
    database: {
      bindingConfigured: Boolean(env.DB),
    },
    tenants,
    secrets: {
      registryConfigured: Boolean(env.TENANT_REGISTRY),
      tenantSecretBindingsConfigured: hasTenantSecretBindings,
    },
  };
}
