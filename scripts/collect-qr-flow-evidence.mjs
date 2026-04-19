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
  ENVIRONMENT_WORKER_HOSTS,
  formatEvidenceMarkdown,
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
  return execFileSync(file, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  const parsed = JSON.parse(rawOutput);

  return Array.isArray(parsed) && parsed[0]?.results ? parsed[0].results : [];
}

/**
 * Busca o `GET /health` no host publico canonico do ambiente.
 *
 * @param {"test" | "production"} environment Ambiente remoto.
 * @returns {Promise<Record<string, unknown>>} JSON de health.
 */
async function fetchHealth(environment) {
  const response = await fetch(buildHealthUrl(environment));

  if (!response.ok) {
    throw new Error(`Health request failed with HTTP ${response.status}.`);
  }

  return response.json();
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

await main();
