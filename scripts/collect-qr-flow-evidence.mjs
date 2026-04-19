#!/usr/bin/env node

/**
 * Coleta evidencia controlada do fluxo ate QR code em `test` ou `production`.
 *
 * Este script foi criado para a issue #90. Ele evita shell ad hoc durante uma
 * janela operacional sensivel e produz uma saida Markdown pronta para issue:
 * - status atual do deploy do Worker
 * - `GET /health` no host publico canonico
 * - estado das migrations do D1 remoto
 * - ultimas `orders` Telegram
 * - ultimas `deposits` correlacionadas ao canal Telegram
 *
 * Exemplo:
 * `node scripts/collect-qr-flow-evidence.mjs --env production --tenant beta --since 2026-04-19T02:00:00Z`
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import {
  buildD1ExecuteArgs,
  buildDeploymentStatusArgs,
  buildHealthUrl,
  buildLatestDepositsQuery,
  buildLatestOrdersQuery,
  buildMigrationsListArgs,
  DEFAULT_OPERATION_TIMEOUT_MS,
  ENVIRONMENT_WORKER_HOSTS,
  formatEvidenceMarkdown,
  parseD1ExecuteJsonOutput,
  readEvidenceCliOptions,
  resolveWranglerInvocation,
} from "./lib/qr-flow-evidence.js";

/**
 * Executa um comando e devolve stdout UTF-8.
 *
 * @param {string} file Binario alvo.
 * @param {string[]} args Argumentos do processo.
 * @returns {string} Saida padrao.
 */
function runCommand(file, args) {
  try {
    return execFileSync(file, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_OPERATION_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(buildCommandFailureMessage(file, args, error), { cause: error });
  }
}

const WRANGLER_INVOCATION = resolveWranglerInvocation({
  cwd: process.cwd(),
  platform: process.platform,
  nodeBinary: process.execPath,
  env: process.env,
  fileExists: existsSync,
});

/**
 * Executa um comando do Wrangler usando resolucao robusta.
 *
 * @param {string[]} args Argumentos apos `wrangler`.
 * @returns {string} Stdout bruto.
 */
function runWrangler(args) {
  return runCommand(WRANGLER_INVOCATION.file, [...WRANGLER_INVOCATION.argsPrefix, ...args]);
}

/**
 * Executa uma query remota no D1 e devolve apenas as linhas.
 *
 * @param {"test" | "production"} environment Ambiente remoto.
 * @param {string} sql SQL a executar.
 * @returns {Array<Record<string, unknown>>} Linhas retornadas.
 */
function runD1Query(environment, sql) {
  const rawOutput = runWrangler(buildD1ExecuteArgs(environment, sql));
  return parseD1ExecuteJsonOutput(rawOutput);
}

/**
 * Busca o `GET /health` no host publico canonico do ambiente.
 *
 * @param {"test" | "production"} environment Ambiente remoto.
 * @returns {Promise<Record<string, unknown>>} JSON de health.
 */
async function fetchHealth(environment) {
  const healthUrl = buildHealthUrl(environment);
  /** @type {Response} */
  let response;

  try {
    response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(DEFAULT_OPERATION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Health request failed before HTTP response for ${healthUrl}: ${formatUnknownError(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(`Health request failed for ${healthUrl} with HTTP ${response.status}.`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Health response from ${healthUrl} was not valid JSON: ${formatUnknownError(error)}`, {
      cause: error,
    });
  }
}

/**
 * Coleta todos os artefatos e imprime Markdown final.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = readEvidenceCliOptions(process.argv.slice(2));
  const deploymentStatus = runWrangler(buildDeploymentStatusArgs(options.environment));
  const migrationsStatus = runWrangler(buildMigrationsListArgs(options.environment));
  const orders = runD1Query(options.environment, buildLatestOrdersQuery(options));
  const deposits = runD1Query(options.environment, buildLatestDepositsQuery(options));
  const health = await fetchHealth(options.environment);
  const gitCommit = runCommand("git", ["rev-parse", "HEAD"]).trim();
  const markdown = formatEvidenceMarkdown({
    issueNumber: options.issueNumber,
    environment: options.environment,
    generatedAt: new Date().toISOString(),
    tenantId: options.tenantId,
    sinceIso: options.sinceIso,
    workerUrl: ENVIRONMENT_WORKER_HOSTS[options.environment],
    gitCommit,
    deploymentStatus,
    migrationsStatus,
    health,
    orders,
    deposits,
  });

  process.stdout.write(`${markdown}\n`);
}

/**
 * Cria uma mensagem curta, mas suficiente, para falhas de processo.
 *
 * @param {string} file Binario executado.
 * @param {string[]} args Argumentos usados.
 * @param {unknown} error Erro lancado pelo Node.
 * @returns {string} Diagnostico pronto para operador.
 */
function buildCommandFailureMessage(file, args, error) {
  const commandLine = [file, ...args].join(" ");
  const status = typeof error === "object" && error && "status" in error ? ` status=${error.status}` : "";
  const signal = typeof error === "object" && error && "signal" in error ? ` signal=${error.signal}` : "";
  const stderr = typeof error === "object" && error && "stderr" in error ? formatProcessOutput(error.stderr) : "";
  const stdout = typeof error === "object" && error && "stdout" in error ? formatProcessOutput(error.stdout) : "";

  return [
    `Command failed: ${commandLine}`,
    `timeoutMs=${DEFAULT_OPERATION_TIMEOUT_MS}${status}${signal}`,
    stderr ? `stderr=${stderr}` : "",
    stdout ? `stdout=${stdout}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/**
 * Normaliza stdout/stderr de erros de processo para uma linha auditavel.
 *
 * @param {unknown} output Valor bruto retornado por `execFileSync`.
 * @returns {string} Texto compacto.
 */
function formatProcessOutput(output) {
  if (typeof output === "string") {
    return output.trim().slice(0, 1_000);
  }

  if (Buffer.isBuffer(output)) {
    return output.toString("utf8").trim().slice(0, 1_000);
  }

  return "";
}

/**
 * Normaliza erros desconhecidos sem perder a mensagem principal.
 *
 * @param {unknown} error Erro bruto.
 * @returns {string} Mensagem segura.
 */
function formatUnknownError(error) {
  return error instanceof Error ? error.message : String(error);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[collect-qr-flow-evidence] ${formatUnknownError(error)}\n`);
  process.exitCode = 1;
}
