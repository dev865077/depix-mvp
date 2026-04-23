/**
 * Logger estruturado e minimo para o MVP.
 *
 * A ideia aqui e gerar logs JSON consistentes para Cloudflare Workers Logs,
 * sempre preservando dados uteis de rastreabilidade e evitando qualquer vazamento
 * de credencial ou header sensivel.
 */

const LOG_LEVEL_SEVERITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

export type LogLevel = keyof typeof LOG_LEVEL_SEVERITY;

export type RuntimeLogConfig = Readonly<{
  appName?: string;
  environment?: string;
  logLevel?: unknown;
}>;

export type LogRecord = Readonly<{
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}>;

export function shouldLog(configuredLevel: LogLevel, incomingLevel: LogLevel): boolean {
  return LOG_LEVEL_SEVERITY[incomingLevel] >= LOG_LEVEL_SEVERITY[configuredLevel];
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(LOG_LEVEL_SEVERITY, value);
}

export function log(runtimeConfig: RuntimeLogConfig | null | undefined, record: LogRecord): void {
  if (!runtimeConfig || !isLogLevel(runtimeConfig.logLevel) || !shouldLog(runtimeConfig.logLevel, record.level)) {
    return;
  }

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      app: runtimeConfig.appName,
      environment: runtimeConfig.environment,
      ...record,
    }),
  );
}
