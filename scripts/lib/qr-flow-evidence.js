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
const SUPPORTED_OPTION_KEYS = new Set(["env", "tenant", "since", "limit", "issue"]);

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
 *   limit: number,
 *   issueNumber: number
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
  const issueNumber = Number.parseInt(values.get("issue") ?? "90", 10);
  const limit = Number.parseInt(values.get("limit") ?? "5", 10);

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
    limit,
    issueNumber,
  };
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
 * Monta um fragmento `WHERE` para consultas operacionais do fluxo Telegram.
 *
 * @param {{
 *   tenantId: string | null,
 *   sinceIso: string | null,
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

  return clauses.join(" AND ");
}

/**
 * Monta a consulta das ultimas orders do canal Telegram.
 *
 * @param {{ tenantId: string | null, sinceIso: string | null, limit: number }} input Filtros opcionais.
 * @returns {string} SQL pronto para `wrangler d1 execute`.
 */
export function buildLatestOrdersQuery(input) {
  return [
    "SELECT",
    "  o.order_id,",
    "  o.tenant_id,",
    "  o.channel,",
    "  o.current_step,",
    "  o.status,",
    "  o.amount_in_cents,",
    "  o.wallet_address,",
    "  o.created_at,",
    "  o.updated_at",
    "FROM orders o",
    `WHERE ${buildTelegramWhereClause({ ...input, alias: "o" })}`,
    "ORDER BY julianday(o.updated_at) DESC, julianday(o.created_at) DESC",
    `LIMIT ${input.limit};`,
  ].join("\n");
}

/**
 * Monta a consulta das ultimas deposits correlacionadas com orders do Telegram.
 *
 * @param {{ tenantId: string | null, sinceIso: string | null, limit: number }} input Filtros opcionais.
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
 * Renderiza um relatorio Markdown pronto para issue ou comentario de PR.
 *
 * @param {{
 *   issueNumber: number,
 *   environment: "test" | "production",
 *   generatedAt: string,
 *   tenantId: string | null,
 *   sinceIso: string | null,
 *   workerUrl: string,
 *   gitCommit: string,
 *   deploymentStatus: string,
 *   migrationsStatus: string,
 *   health: Record<string, unknown>,
 *   orders: Array<Record<string, unknown>>,
 *   deposits: Array<Record<string, unknown>>
 * }} report Dados consolidados.
 * @returns {string} Markdown final.
 */
export function formatEvidenceMarkdown(report) {
  const scopeLine = report.tenantId ? `tenant: \`${report.tenantId}\`` : "tenant: `todos`";
  const sinceLine = report.sinceIso ? `desde: \`${report.sinceIso}\`` : "desde: `sem corte temporal`";

  return [
    `## Evidencia controlada - issue #${report.issueNumber}`,
    "",
    `- ambiente: \`${report.environment}\``,
    `- host canonico: \`${report.workerUrl}\``,
    `- commit local: \`${report.gitCommit}\``,
    `- gerado em: \`${report.generatedAt}\``,
    `- ${scopeLine}`,
    `- ${sinceLine}`,
    "",
    "### Health",
    "",
    "```json",
    JSON.stringify(report.health, null, 2),
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
