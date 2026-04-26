/**
 * Leitura e saneamento da configuracao minima do Worker de produto.
 *
 * As responsabilidades operacionais agora vivem em repos separados. Este
 * runtime mantem apenas o shell HTTP do `depix-mvp` e os ponteiros publicos
 * para os sistemas proprietarios dessas responsabilidades.
 */

type AppEnvironment = "local" | "test" | "production";
type LogLevel = "debug" | "info" | "warn" | "error";
type RuntimeEnv = Record<string, unknown>;

const APP_ENVIRONMENTS = new Set(["local", "test", "production"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

function readOptionalStringBinding(env: RuntimeEnv, key: string): string | undefined {
  const value = env[key];

  return typeof value === "string" ? value : undefined;
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

  return value.trim();
}

function readRepositoryUrl(env: RuntimeEnv, key: string, fallback: string): string {
  return readOptionalStringBinding(env, key)?.trim() || fallback;
}

/**
 * Le o conjunto de bindings do Worker e devolve um runtime seguro e tipado.
 *
 * @param {Record<string, unknown>} env Bindings recebidos do Worker.
 * @returns Configuracao consolidada do runtime.
 */
export async function readRuntimeConfig(env: RuntimeEnv) {
  const appName = assertRequiredString(readOptionalStringBinding(env, "APP_NAME"), "APP_NAME");
  const rawEnvironment = assertRequiredString(readOptionalStringBinding(env, "APP_ENV"), "APP_ENV");
  const rawLogLevel = assertRequiredString(readOptionalStringBinding(env, "LOG_LEVEL"), "LOG_LEVEL");

  if (!APP_ENVIRONMENTS.has(rawEnvironment)) {
    throw new Error(`Invalid APP_ENV value: ${rawEnvironment}`);
  }

  if (!LOG_LEVELS.has(rawLogLevel)) {
    throw new Error(`Invalid LOG_LEVEL value: ${rawLogLevel}`);
  }

  return {
    appName,
    environment: rawEnvironment as AppEnvironment,
    logLevel: rawLogLevel as LogLevel,
    externalSystems: {
      debotRepositoryUrl: readRepositoryUrl(env, "DEBOT_REPOSITORY_URL", "https://github.com/dev865077/DeBot"),
      saguiRepositoryUrl: readRepositoryUrl(env, "SAGUI_REPOSITORY_URL", "https://github.com/dev865077/Sagui"),
      autoIaRepositoryUrl: readRepositoryUrl(env, "AUTOIA_REPOSITORY_URL", "https://github.com/dev865077/AutoIA-Github"),
    },
  };
}
