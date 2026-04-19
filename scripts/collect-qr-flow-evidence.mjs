#!/usr/bin/env node

/**
 * Coleta evidencia controlada do fluxo ate QR code em `test` ou `production`.
 *
 * Este arquivo e propositalmente fino: ele conecta dependencias reais do Node
 * ao runtime testavel em `scripts/lib/qr-flow-evidence.js`. Assim, a logica de
 * Wrangler, D1, health e Markdown fica coberta por teste sem depender de rede.
 *
 * Exemplo:
 * `node scripts/collect-qr-flow-evidence.mjs --env production --tenant beta --since 2026-04-19T02:00:00Z`
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runQrFlowEvidenceCli } from "./lib/qr-flow-evidence.js";

if (isDirectExecution()) {
  process.exitCode = await runQrFlowEvidenceCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    platform: process.platform,
    nodeBinary: process.execPath,
    env: process.env,
    fileExists: existsSync,
    execFileSync,
    fetch,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

/**
 * Detecta execucao direta sem disparar a CLI quando o modulo e importado.
 *
 * @returns {boolean} `true` quando o arquivo e o entrypoint do processo.
 */
function isDirectExecution() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
