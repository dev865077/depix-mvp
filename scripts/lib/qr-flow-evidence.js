/**
 * Utilitarios para coleta controlada de evidencia do fluxo ate QR code.
 *
 * O objetivo deste modulo e manter a parte sensivel do script operacional
 * pequena, previsivel e testavel:
 * - interpretar argumentos de CLI sem heuristica escondida
 * - derivar os hosts canonicos de `test` e `production`
 * - montar as consultas SQL remotas com filtros explicitos
 * - renderizar um relatorio Markdown pronto para issue ou PR
 *
 * O script que fala com Wrangler e HTTP usa estas funcoes como borda pura.
 */
import { resolve } from "node:path";

/**
 * Mapeia cada ambiente remoto para o host publico canonico do Worker.
 *
 * A principal dor operacional da issue #90 foi ruido sobre qual host de
 * `workers.dev` era o certo. Centralizar isso aqui evita repetir a mesma
 * ambiguidade em shell solto, wiki e comentarios.
 *
 * @type {Readonly<Record<"test" | "production", string>>}
 */
export const ENVIRONMENT_WORKER_HOSTS = Object.freeze({
  test: "https://depix-mvp-test.dev865077.workers.dev",
  production: "https://depix-mvp-production.dev865077.workers.dev",
});

/**
 * Chaves aceitas pelo parser simples de CLI.
 *
 * @type {ReadonlySet<string>}
 */
const SUPPORTED_OPTION_KEYS = new Set([
  "env",
  "tenant",
  "since",
  "limit",
  "issue",
  "order-id",
  "deposit-entry-id",
  "require-split-proof",
]);

const FLAG_OPTION_KEYS = new Set(["require-split-proof"]);

/**
 * Nome da variavel de ambiente que permite ao operador apontar um Wrangler
 * especifico sem depender de layout de `node_modules`.
 *
 * @type {string}
 */
export const WRANGLER_BINARY_ENV_KEY = "WRANGLER_BIN";

/**
 * Timeout unico para chamadas operacionais do coletor.
 *
 * A ferramenta existe para ser usada durante investigacao de producao. Por
 * isso, uma dependencia lenta deve falhar com diagnostico claro em vez de
 * deixar o operador aguardando indefinidamente.
 *
 * @type {number}
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

/**
 * Resolve o host publico canonico do ambiente remoto.
 *
 * @param {string} environment Ambiente alvo informado pelo operador.
 * @returns {"test" | "production"} Ambiente normalizado.
 */
export function normalizeRemoteEnvironment(environment) {
  if (environment === "test" || environment === "production") {
    return environment;
  }

  throw new Error("The --env option must be either 'test' or 'production'.");
}

/**
 * Monta a URL canonica de health do ambiente.
 *
 * @param {"test" | "production"} environment Ambiente remoto ja validado.
 * @returns {string} URL canonica de `GET /health`.
 */
export function buildHealthUrl(environment) {
  return `${ENVIRONMENT_WORKER_HOSTS[environment]}/health`;
}

/**
 * Interpreta argumentos simples no formato `--chave valor`.
 *
 * O parser e intencionalmente conservador para evitar aceitar entradas
 * parcialmente invalidas durante uma janela operacional sensivel.
 *
 * @param {string[]} argv Argumentos crus da CLI, sem `node` e sem path do script.
 * @returns {{
 *   environment: "test" | "production",
 *   tenantId: string | null,
 *   sinceIso: string | null,
 *   orderId: string | null,
 *   depositEntryId: string | null,
 *   limit: number,
 *   issueNumber: number,
 *   requireSplitProof: boolean
 * }} Opcoes normalizadas.
 */
export function readEvidenceCliOptions(argv) {
  /** @type {Map<string, string>} */
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith("--")) {
      throw new Error(`Unexpected positional argument '${current}'. Use --env, --tenant, --since, --limit or --issue.`);
    }

    const key = current.slice(2);

    if (!SUPPORTED_OPTION_KEYS.has(key)) {
      throw new Error(`Unsupported option '${current}'.`);
    }

    if (FLAG_OPTION_KEYS.has(key)) {
      values.set(key, "true");
      continue;
    }

    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      throw new Error(`Option '${current}' requires a value.`);
    }

    values.set(key, next);
    index += 1;
  }

  const environment = normalizeRemoteEnvironment(values.get("env") ?? "production");
  const tenantId = values.get("tenant")?.trim() || null;
  const sinceIso = values.get("since")?.trim() || null;
  const orderId = values.get("order-id")?.trim() || null;
  const depositEntryId = values.get("deposit-entry-id")?.trim() || null;
  const issueNumber = Number.parseInt(values.get("issue") ?? "90", 10);
  const limit = Number.parseInt(values.get("limit") ?? "5", 10);
  const requireSplitProof = values.get("require-split-proof") === "true";

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("The --issue option must be a positive integer.");
  }

  if (!Number.isInteger(limit) || limit <= 0 || limit > 20) {
    throw new Error("The --limit option must be an integer between 1 and 20.");
  }

  if (sinceIso) {
    const parsed = Date.parse(sinceIso);

    if (Number.isNaN(parsed)) {
      throw new Error("The --since option must be a valid ISO-8601 timestamp.");
    }
  }

  return {
    environment,
    tenantId,
    sinceIso,
    orderId,
    depositEntryId,
    limit,
    issueNumber,
    requireSplitProof,
  };
}

export class SplitProofRequirementError extends Error {
  /**
   * @param {string} status Status de splitProof observado.
   * @param {string} markdown Relatorio ja renderizado.
   */
  constructor(status, markdown) {
    super(`Split proof requirement failed with status '${status}'.`);
    this.name = "SplitProofRequirementError";
    this.status = status;
    this.markdown = markdown;
  }
}

/**
 * Resolve como o script deve chamar o Wrangler.
 *
 * Ordem de preferencia:
 * 1. `WRANGLER_BIN`, quando o operador quer fixar um binario especifico
 * 2. Wrangler versionado do repositorio, quando `node_modules` esta instalado
 * 3. `wrangler.cmd` no Windows ou `wrangler` em outros sistemas
 *
 * O retorno separa `file` e `argsPrefix` para manter `execFileSync` sem shell.
 *
 * @param {{
 *   cwd: string,
 *   platform: NodeJS.Platform,
 *   nodeBinary: string,
 *   env?: Record<string, string | undefined>,
 *   fileExists: (path: string) => boolean
 * }} input Contexto de execucao.
 * @returns {{ file: string, argsPrefix: string[], source: "env" | "local-package" | "path" }} Plano de execucao.
 */
export function resolveWranglerInvocation(input) {
  const configuredBinary = input.env?.[WRANGLER_BINARY_ENV_KEY]?.trim();

  if (configuredBinary) {
    return {
      file: configuredBinary,
      argsPrefix: [],
      source: "env",
    };
  }

  const localEntrypoint = resolve(input.cwd, "node_modules", "wrangler", "bin", "wrangler.js");

  if (input.fileExists(localEntrypoint)) {
    return {
      file: input.nodeBinary,
      argsPrefix: [localEntrypoint],
      source: "local-package",
    };
  }

  return {
    file: input.platform === "win32" ? "wrangler.cmd" : "wrangler",
    argsPrefix: [],
    source: "path",
  };
}

/**
 * Monta os argumentos do Wrangler para consultar o deployment atual.
 *
 * @param {"test" | "production"} environment Ambiente remoto.
 * @returns {string[]} Argumentos de CLI.
 */
export function buildDeploymentStatusArgs(environment) {
  return ["deployments", "status", "--env", environment];
}

/**
 * Monta os argumentos do Wrangler para listar migrations remotas do D1.
 *
 * @param {"test" | "production"} environment Ambiente remoto.
 * @returns {string[]} Argumentos de CLI.
 */
export function buildMigrationsListArgs(environment) {
  return ["d1", "migrations", "list", "DB", "--remote", "--env", environment];
}

/**
 * Monta os argumentos do Wrangler para executar SQL remoto no D1.
 *
 * @param {"test" | "production"} environment Ambiente remoto.
 * @param {string} sql SQL ja montado.
 * @returns {string[]} Argumentos de CLI.
 */
export function buildD1ExecuteArgs(environment, sql) {
  return ["d1", "execute", "DB", "--remote", "--env", environment, "--json", "--command", sql];
}

/**
 * @typedef {{
 *   argv?: string[],
 *   cwd: string,
 *   platform: NodeJS.Platform,
 *   nodeBinary: string,
 *   env: Record<string, string | undefined>,
 *   fileExists: (path: string) => boolean,
 *   execFileSync: (file: string, args: string[], options: Record<string, unknown>) => string | Uint8Array,
 *   fetch: typeof fetch,
 *   now?: () => Date,
 *   stdout?: { write: (chunk: string) => unknown },
 *   stderr?: { write: (chunk: string) => unknown }
 * }} QrFlowEvidenceRuntimeDependencies
 */

/**
 * Cria o runtime do coletor com dependencias injetaveis.
 *
 * O arquivo executavel injeta Node, Wrangler, `fetch` e filesystem reais. Os
 * testes injetam dublês determinísticos, cobrindo o caminho inteiro sem tocar
 * rede, D1 remoto ou binarios locais.
 *
 * @param {QrFlowEvidenceRuntimeDependencies} dependencies Dependencias do runtime.
 * @returns {{
 *   collect: (argv: string[]) => Promise<string>,
 *   runCommand: (file: string, args: string[]) => string,
 *   runWrangler: (args: string[]) => string,
 *   runD1Query: (environment: "test" | "production", sql: string) => Array<Record<string, unknown>>,
 *   fetchHealth: (environment: "test" | "production") => Promise<Record<string, unknown>>
 * }} Funcoes do runtime.
 */
export function createQrFlowEvidenceCollector(dependencies) {
  const now = dependencies.now ?? (() => new Date());
  const wranglerInvocation = resolveWranglerInvocation({
    cwd: dependencies.cwd,
    platform: dependencies.platform,
    nodeBinary: dependencies.nodeBinary,
    env: dependencies.env,
    fileExists: dependencies.fileExists,
  });

  /**
   * Executa um comando e devolve stdout UTF-8.
   *
   * @param {string} file Binario alvo.
   * @param {string[]} args Argumentos do processo.
   * @returns {string} Saida padrao.
   */
  function runCommand(file, args) {
    try {
      const output = dependencies.execFileSync(file, args, {
        cwd: dependencies.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_OPERATION_TIMEOUT_MS,
        windowsHide: true,
      });

      return typeof output === "string" ? output : new TextDecoder().decode(output);
    } catch (error) {
      throw new Error(buildCommandFailureMessage(file, args, error), { cause: error });
    }
  }

  /**
   * Executa um comando do Wrangler usando resolucao robusta.
   *
   * @param {string[]} args Argumentos apos `wrangler`.
   * @returns {string} Stdout bruto.
   */
  function runWrangler(args) {
    return runCommand(wranglerInvocation.file, [...wranglerInvocation.argsPrefix, ...args]);
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
    let response;

    try {
      response = await dependencies.fetch(healthUrl, {
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
   * Coleta todos os artefatos e renderiza o Markdown final.
   *
   * @param {string[]} argv Argumentos crus da CLI.
   * @returns {Promise<string>} Relatorio Markdown.
   */
  async function collect(argv) {
    const options = readEvidenceCliOptions(argv);
    const deploymentStatus = runWrangler(buildDeploymentStatusArgs(options.environment));
    const migrationsStatus = runWrangler(buildMigrationsListArgs(options.environment));
    const orders = runD1Query(options.environment, buildLatestOrdersQuery(options));
    const deposits = runD1Query(options.environment, buildLatestDepositsQuery(options));
    const depositEvents = runD1Query(options.environment, buildLatestDepositEventsQuery(options));
    const health = await fetchHealth(options.environment);
    const gitCommit = runCommand("git", ["rev-parse", "HEAD"]).trim();
    const splitProof = buildSplitProofReport(orders, deposits, depositEvents);

    const markdown = formatEvidenceMarkdown({
      issueNumber: options.issueNumber,
      environment: options.environment,
      generatedAt: now().toISOString(),
      tenantId: options.tenantId,
      sinceIso: options.sinceIso,
      orderId: options.orderId,
      depositEntryId: options.depositEntryId,
      workerUrl: ENVIRONMENT_WORKER_HOSTS[options.environment],
      gitCommit,
      deploymentStatus,
      migrationsStatus,
      health,
      opsReadiness: buildOpsReadinessReport(health),
      splitProof,
      orders,
      deposits,
      depositEvents,
    });

    if (options.requireSplitProof && splitProof.status !== "proved") {
      throw new SplitProofRequirementError(splitProof.status, markdown);
    }

    return markdown;
  }

  return {
    collect,
    runCommand,
    runWrangler,
    runD1Query,
    fetchHealth,
  };
}

/**
 * Executa a CLI do coletor e converte excecoes em exit code.
 *
 * @param {QrFlowEvidenceRuntimeDependencies} dependencies Dependencias do runtime.
 * @returns {Promise<number>} Exit code sugerido.
 */
export async function runQrFlowEvidenceCli(dependencies) {
  const collector = createQrFlowEvidenceCollector(dependencies);
  const argv = dependencies.argv ?? [];
  const stdout = dependencies.stdout;
  const stderr = dependencies.stderr;

  try {
    const markdown = await collector.collect(argv);

    stdout?.write(`${markdown}\n`);
    return 0;
  } catch (error) {
    if (error instanceof SplitProofRequirementError) {
      stdout?.write(`${error.markdown}\n`);
    }

    stderr?.write(`[collect-qr-flow-evidence] ${formatUnknownError(error)}\n`);
    return 1;
  }
}

/**
 * Interpreta a saida JSON do `wrangler d1 execute --json`.
 *
 * Wrangler retorna uma lista de resultados por statement. O coletor executa
 * sempre um unico `SELECT`, entao exigimos explicitamente `parsed[0].results`
 * como array. Qualquer outro formato indica falha operacional ou mudanca de
 * contrato da CLI e deve interromper a evidencia, nunca virar lista vazia.
 *
 * @param {string} rawOutput Stdout bruto do Wrangler.
 * @returns {Array<Record<string, unknown>>} Linhas retornadas pelo D1.
 */
export function parseD1ExecuteJsonOutput(rawOutput) {
  /** @type {unknown} */
  let parsed;

  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    throw new Error("Wrangler D1 output was not valid JSON. Check Wrangler stdout/stderr before trusting this evidence.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler D1 output did not use the expected array envelope.");
  }

  const [firstStatement] = parsed;

  if (!firstStatement || typeof firstStatement !== "object" || !("results" in firstStatement)) {
    throw new Error("Wrangler D1 output did not include a results array for the executed SELECT.");
  }

  const results = firstStatement.results;

  if (!Array.isArray(results)) {
    throw new Error("Wrangler D1 output included a non-array results field.");
  }

  return results.filter((row) => row && typeof row === "object");
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

  if (output instanceof Uint8Array) {
    return new TextDecoder().decode(output).trim().slice(0, 1_000);
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

/**
 * Monta um fragmento `WHERE` para consultas operacionais do fluxo Telegram.
 *
 * @param {{
 *   tenantId: string | null,
 *   sinceIso: string | null,
 *   orderId?: string | null,
 *   alias: string
 * }} input Filtros opcionais.
 * @returns {string} Fragmento SQL sem a palavra `WHERE`.
 */
export function buildTelegramWhereClause(input) {
  /** @type {string[]} */
  const clauses = [`${input.alias}.channel = 'telegram'`];

  if (input.tenantId) {
    clauses.push(`${input.alias}.tenant_id = '${escapeSqlLiteral(input.tenantId)}'`);
  }

  if (input.sinceIso) {
    clauses.push(
      `(julianday(${input.alias}.updated_at) >= julianday('${escapeSqlLiteral(input.sinceIso)}') OR julianday(${input.alias}.created_at) >= julianday('${escapeSqlLiteral(input.sinceIso)}'))`,
    );
  }

  if (input.orderId) {
    clauses.push(`${input.alias}.order_id = '${escapeSqlLiteral(input.orderId)}'`);
  }

  return clauses.join(" AND ");
}

/**
 * Monta a consulta das ultimas orders do canal Telegram.
 *
 * @param {{ tenantId: string | null, sinceIso: string | null, orderId?: string | null, depositEntryId?: string | null, limit: number }} input Filtros opcionais.
 * @returns {string} SQL pronto para `wrangler d1 execute`.
 */
export function buildLatestOrdersQuery(input) {
  const whereClause = buildTelegramWhereClause({ ...input, alias: "o" });
  const depositFilterClause = input.depositEntryId
    ? [
      "EXISTS (",
      "  SELECT 1",
      "  FROM deposits d",
      "  WHERE d.tenant_id = o.tenant_id",
      "    AND d.order_id = o.order_id",
      `    AND d.deposit_entry_id = '${escapeSqlLiteral(input.depositEntryId)}'`,
      ")",
    ].join("\n")
    : null;

  return [
    "SELECT",
    "  o.order_id,",
    "  o.tenant_id,",
    "  o.channel,",
    "  o.telegram_chat_id,",
    "  o.current_step,",
    "  o.status,",
    "  o.amount_in_cents,",
    "  o.wallet_address,",
    "  o.split_address,",
    "  o.split_fee,",
    "  o.created_at,",
    "  o.updated_at",
    "FROM orders o",
    `WHERE ${[whereClause, depositFilterClause].filter(Boolean).join(" AND ")}`,
    "ORDER BY julianday(o.updated_at) DESC, julianday(o.created_at) DESC",
    `LIMIT ${input.limit};`,
  ].join("\n");
}

/**
 * Monta a consulta das ultimas deposits correlacionadas com orders do Telegram.
 *
 * @param {{ tenantId: string | null, sinceIso: string | null, orderId?: string | null, depositEntryId?: string | null, limit: number }} input Filtros opcionais.
 * @returns {string} SQL pronto para `wrangler d1 execute`.
 */
export function buildLatestDepositsQuery(input) {
  /** @type {string[]} */
  const clauses = ["o.channel = 'telegram'"];

  if (input.tenantId) {
    clauses.push(`d.tenant_id = '${escapeSqlLiteral(input.tenantId)}'`);
  }

  if (input.sinceIso) {
    clauses.push(
      `(julianday(d.updated_at) >= julianday('${escapeSqlLiteral(input.sinceIso)}') OR julianday(d.created_at) >= julianday('${escapeSqlLiteral(input.sinceIso)}'))`,
    );
  }

  if (input.orderId) {
    clauses.push(`d.order_id = '${escapeSqlLiteral(input.orderId)}'`);
  }

  if (input.depositEntryId) {
    clauses.push(`d.deposit_entry_id = '${escapeSqlLiteral(input.depositEntryId)}'`);
  }

  return [
    "SELECT",
    "  d.tenant_id,",
    "  d.order_id,",
    "  d.deposit_entry_id,",
    "  d.qr_id,",
    "  d.external_status,",
    "  LENGTH(d.qr_copy_paste) AS qr_copy_paste_len,",
    "  LENGTH(d.qr_image_url) AS qr_image_url_len,",
    "  d.created_at,",
    "  d.updated_at",
    "FROM deposits d",
    "INNER JOIN orders o ON o.order_id = d.order_id",
    `WHERE ${clauses.join(" AND ")}`,
    "ORDER BY julianday(d.updated_at) DESC, julianday(d.created_at) DESC",
    `LIMIT ${input.limit};`,
  ].join("\n");
}

/**
 * Monta a consulta dos eventos de deposito correlacionados ao fluxo Telegram.
 *
 * `raw_payload` fica deliberadamente fora da selecao para manter o relatorio
 * pronto para issue/PR sem vazar payload financeiro bruto.
 *
 * @param {{ tenantId: string | null, sinceIso: string | null, orderId?: string | null, depositEntryId?: string | null, limit: number }} input Filtros opcionais.
 * @returns {string} SQL pronto para `wrangler d1 execute`.
 */
export function buildLatestDepositEventsQuery(input) {
  /** @type {string[]} */
  const clauses = ["o.channel = 'telegram'"];

  if (input.tenantId) {
    clauses.push(`e.tenant_id = '${escapeSqlLiteral(input.tenantId)}'`);
  }

  if (input.sinceIso) {
    clauses.push(`julianday(e.received_at) >= julianday('${escapeSqlLiteral(input.sinceIso)}')`);
  }

  if (input.orderId) {
    clauses.push(`e.order_id = '${escapeSqlLiteral(input.orderId)}'`);
  }

  if (input.depositEntryId) {
    clauses.push(`e.deposit_entry_id = '${escapeSqlLiteral(input.depositEntryId)}'`);
  }

  if (!input.orderId && !input.depositEntryId) {
    clauses.push([
      "EXISTS (",
      "  SELECT 1",
      "  FROM deposits d",
      "  WHERE d.tenant_id = e.tenant_id",
      "    AND d.order_id = e.order_id",
      "    AND d.deposit_entry_id = e.deposit_entry_id",
      ")",
    ].join("\n"));
  }

  return [
    "SELECT",
    "  e.id,",
    "  e.tenant_id,",
    "  e.order_id,",
    "  e.deposit_entry_id,",
    "  e.qr_id,",
    "  e.source,",
    "  e.external_status,",
    "  e.bank_tx_id,",
    "  e.blockchain_tx_id,",
    "  e.received_at",
    "FROM deposit_events e",
    "INNER JOIN orders o ON o.tenant_id = e.tenant_id AND o.order_id = e.order_id",
    `WHERE ${clauses.join(" AND ")}`,
    "ORDER BY julianday(e.received_at) DESC, e.id DESC",
    `LIMIT ${input.limit};`,
  ].join("\n");
}

/**
 * Extrai do health apenas o contrato operacional necessario para o relatorio.
 *
 * @param {Record<string, unknown>} health Payload de `/health`.
 * @returns {{ depositRecheck: { state: string, ready: boolean }, depositsFallback: { state: string, ready: boolean } }} Readiness redigido.
 */
export function buildOpsReadinessReport(health) {
  const operations = health && typeof health.operations === "object" && health.operations !== null
    ? health.operations
    : {};

  return {
    depositRecheck: normalizeOperationReadiness(operations.depositRecheck),
    depositsFallback: normalizeOperationReadiness(operations.depositsFallback),
  };
}

/**
 * Deriva um resumo auditavel da prova de split usando apenas os rastros
 * persistidos hoje no sistema.
 *
 * @param {Array<Record<string, unknown>>} orders Orders correlacionadas.
 * @param {Array<Record<string, unknown>>} deposits Depositos correlacionados.
 * @param {Array<Record<string, unknown>>} depositEvents Eventos correlacionados.
 * @returns {{
 *   status: "not_applicable" | "missing_split_config" | "pending_settlement" | "proved" | "missing_onchain_tx" | "missing_financial_trace",
 *   orderIds: string[],
 *   bankTxIds: string[],
 *   blockchainTxIds: string[],
 *   splitConfiguredOrders: number,
 *   settledOrders: number
 * }} Resumo auditavel de split.
 */
export function buildSplitProofReport(orders, deposits, depositEvents) {
  const normalizedOrders = Array.isArray(orders) ? orders : [];
  const normalizedDeposits = Array.isArray(deposits) ? deposits : [];
  const normalizedEvents = Array.isArray(depositEvents) ? depositEvents : [];
  const orderIds = collectDistinctTextValues(normalizedOrders, "order_id");
  const splitConfiguredOrders = normalizedOrders.filter(isSplitConfiguredOrder).length;
  const relevantSettledOrderIds = collectDistinctTextValues(
    normalizedDeposits.filter((deposit) => (
      readTextValue(deposit, "external_status") === "depix_sent"
      && orderIds.includes(readTextValue(deposit, "order_id") ?? "")
    )),
    "order_id",
  );
  const relevantEvents = normalizedEvents.filter((event) => relevantSettledOrderIds.includes(readTextValue(event, "order_id") ?? ""));
  const bankTxIds = collectDistinctTextValues(relevantEvents, "bank_tx_id");
  const blockchainTxIds = collectDistinctTextValues(relevantEvents, "blockchain_tx_id");
  const provedOrderIds = collectDistinctTextValues(
    relevantEvents.filter((event) => Boolean(readTextValue(event, "blockchain_tx_id"))),
    "order_id",
  );
  const settledOrders = relevantSettledOrderIds.length;

  if (orderIds.length === 0) {
    return {
      status: "not_applicable",
      orderIds,
      bankTxIds,
      blockchainTxIds,
      splitConfiguredOrders: 0,
      settledOrders: 0,
    };
  }

  if (splitConfiguredOrders === 0) {
    return {
      status: "missing_split_config",
      orderIds,
      bankTxIds,
      blockchainTxIds,
      splitConfiguredOrders,
      settledOrders,
    };
  }

  if (settledOrders === 0) {
    return {
      status: "pending_settlement",
      orderIds,
      bankTxIds,
      blockchainTxIds,
      splitConfiguredOrders,
      settledOrders,
    };
  }

  if (settledOrders > 0 && provedOrderIds.length === settledOrders) {
    return {
      status: "proved",
      orderIds,
      bankTxIds,
      blockchainTxIds,
      splitConfiguredOrders,
      settledOrders,
    };
  }

  if (bankTxIds.length > 0) {
    return {
      status: "missing_onchain_tx",
      orderIds,
      bankTxIds,
      blockchainTxIds,
      splitConfiguredOrders,
      settledOrders,
    };
  }

  return {
    status: "missing_financial_trace",
    orderIds,
    bankTxIds,
    blockchainTxIds,
    splitConfiguredOrders,
    settledOrders,
  };
}

/**
 * Normaliza uma entrada de readiness operacional sem preservar campos extras.
 *
 * @param {unknown} value Entrada de `health.operations`.
 * @returns {{ state: string, ready: boolean }} Readiness seguro para Markdown.
 */
function normalizeOperationReadiness(value) {
  if (!value || typeof value !== "object") {
    return {
      state: "missing",
      ready: false,
    };
  }

  return {
    state: typeof value.state === "string" ? value.state : "unknown",
    ready: value.ready === true,
  };
}

/**
 * @param {Array<Record<string, unknown>>} rows Linhas candidatas.
 * @param {string} field Campo textual.
 * @returns {string[]} Valores distintos em ordem de aparicao.
 */
function collectDistinctTextValues(rows, field) {
  const seen = new Set();

  return rows.reduce((values, row) => {
    const value = readTextValue(row, field);

    if (!value || seen.has(value)) {
      return values;
    }

    seen.add(value);
    return [...values, value];
  }, []);
}

/**
 * @param {Record<string, unknown>} order Linha de order.
 * @returns {boolean} `true` quando o split materializado existe na order.
 */
function isSplitConfiguredOrder(order) {
  return Boolean(readTextValue(order, "split_address")) && Boolean(readTextValue(order, "split_fee"));
}

/**
 * @param {Record<string, unknown>} row Linha arbitraria.
 * @param {string} field Campo textual.
 * @returns {string | null} Texto limpo ou `null`.
 */
function readTextValue(row, field) {
  const value = typeof row?.[field] === "string" ? row[field].trim() : "";

  return value.length > 0 ? value : null;
}

/**
 * Renderiza um relatorio Markdown pronto para issue ou comentario de PR.
 *
 * @param {{
 *   issueNumber: number,
 *   environment: "test" | "production",
 *   generatedAt: string,
 *   tenantId: string | null,
 *   sinceIso: string | null,
 *   orderId: string | null,
 *   depositEntryId: string | null,
 *   workerUrl: string,
 *   gitCommit: string,
 *   deploymentStatus: string,
 *   migrationsStatus: string,
 *   health: Record<string, unknown>,
 *   opsReadiness: { depositRecheck: { state: string, ready: boolean }, depositsFallback: { state: string, ready: boolean } },
 *   splitProof: {
 *     status: string,
 *     orderIds: string[],
 *     bankTxIds: string[],
 *     blockchainTxIds: string[],
 *     splitConfiguredOrders: number,
 *     settledOrders: number
 *   },
 *   orders: Array<Record<string, unknown>>,
 *   deposits: Array<Record<string, unknown>>,
 *   depositEvents: Array<Record<string, unknown>>
 * }} report Dados consolidados.
 * @returns {string} Markdown final.
 */
export function formatEvidenceMarkdown(report) {
  const scopeLine = report.tenantId ? `tenant: \`${report.tenantId}\`` : "tenant: `todos`";
  const sinceLine = report.sinceIso ? `desde: \`${report.sinceIso}\`` : "desde: `sem corte temporal`";
  const orderLine = report.orderId ? `order: \`${report.orderId}\`` : "order: `sem filtro`";
  const depositLine = report.depositEntryId ? `depositEntryId: \`${report.depositEntryId}\`` : "depositEntryId: `sem filtro`";

  return [
    `## Evidencia controlada - issue #${report.issueNumber}`,
    "",
    `- ambiente: \`${report.environment}\``,
    `- host canonico: \`${report.workerUrl}\``,
    `- commit local: \`${report.gitCommit}\``,
    `- gerado em: \`${report.generatedAt}\``,
    `- ${scopeLine}`,
    `- ${sinceLine}`,
    `- ${orderLine}`,
    `- ${depositLine}`,
    "",
    "### Health",
    "",
    "```json",
    JSON.stringify(report.health, null, 2),
    "```",
    "",
    "### Ops readiness",
    "",
    "```json",
    JSON.stringify(report.opsReadiness, null, 2),
    "```",
    "",
    "### Split proof",
    "",
    "```json",
    JSON.stringify(report.splitProof, null, 2),
    "```",
    "",
    "### Deployment status",
    "",
    "```text",
    report.deploymentStatus.trim(),
    "```",
    "",
    "### Migrations status",
    "",
    "```text",
    report.migrationsStatus.trim(),
    "```",
    "",
    "### Orders Telegram",
    "",
    "```json",
    JSON.stringify(report.orders, null, 2),
    "```",
    "",
    "### Deposits correlacionados",
    "",
    "```json",
    JSON.stringify(report.deposits, null, 2),
    "```",
    "",
    "### Deposit events correlacionados",
    "",
    "```json",
    JSON.stringify(report.depositEvents, null, 2),
    "```",
  ].join("\n");
}

/**
 * Escapa aspas simples em literais SQL simples.
 *
 * @param {string} value Valor bruto.
 * @returns {string} Valor seguro para SQL literal simples.
 */
function escapeSqlLiteral(value) {
  return value.replaceAll("'", "''");
}
