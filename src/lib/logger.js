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
};

export function shouldLog(configuredLevel, incomingLevel) {
  return LOG_LEVEL_SEVERITY[incomingLevel] >= LOG_LEVEL_SEVERITY[configuredLevel];
}

export function log(runtimeConfig, record) {
  if (!runtimeConfig || !shouldLog(runtimeConfig.logLevel, record.level)) {
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
