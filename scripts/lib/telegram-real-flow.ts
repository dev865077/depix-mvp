import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const TELEGRAM_REAL_FLOW_WORKER_HOSTS = Object.freeze({
  test: "https://depix-mvp-test.dev865077.workers.dev",
  production: "https://depix-mvp-production.dev865077.workers.dev",
});

export const TELEGRAM_REAL_FLOW_ALLOWED_UPDATES = Object.freeze(["message", "callback_query"]);
export const TELEGRAM_REAL_FLOW_PUBLIC_COMMANDS = Object.freeze(["start", "help", "status", "cancel"]);
export const DEFAULT_REAL_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export type TelegramRealFlowEnvironment = keyof typeof TELEGRAM_REAL_FLOW_WORKER_HOSTS;

export type CliFlagMap = ReadonlyMap<string, string | true>;

export type TelegramPreflightOptions = Readonly<{
  environment: TelegramRealFlowEnvironment;
  tenantId: string;
  publicBaseUrl: string;
  opsBearerToken: string | null;
  outputPath: string;
  issueNumber: number;
}>;

export type TelegramRealRunOptions = Readonly<{
  environment: TelegramRealFlowEnvironment;
  tenantId: string;
  amountBrl: string;
  walletAddress: string;
  outputPath: string;
  confirmReal: boolean;
  requirePaymentConfirmed: boolean;
  timeoutMs: number;
}>;

export type PreflightCheck = Readonly<{
  name: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
}>;

export type TelegramPreflightReport = Readonly<{
  kind: "telegram_real_flow_preflight";
  status: "success" | "failure";
  generatedAt: string;
  environment: TelegramRealFlowEnvironment;
  tenantId: string;
  publicBaseUrl: string;
  checks: PreflightCheck[];
  healthRequestId: string | null;
  expectedWebhookUrl: string;
}>;

export type ParsedTailLogRecord = Readonly<{
  timestamp?: string;
  level?: string;
  message?: string;
  tenantId?: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  details?: Record<string, unknown>;
}>;

export type ConversationObservation = Readonly<{
  status: "success" | "failure";
  reason: string | null;
  requestIds: string[];
  orderIds: string[];
  depositEntryIds: string[];
  sawStart: boolean;
  sawReviewOrWalletStep: boolean;
  sawCallbackQuery: boolean;
  sawCallbackConfirmation: boolean;
  sawPixGenerated: boolean;
  sawPaymentConfirmed: boolean;
  sawEulenWebhook: boolean;
  sawSplitEvidence: boolean;
}>;

export type TelegramRealRunReport = Readonly<{
  kind: "telegram_real_flow_real_run";
  status: "success" | "failure" | "aborted";
  generatedAt: string;
  environment: TelegramRealFlowEnvironment;
  tenantId: string;
  amountBrl: string;
  walletAddressProvided: boolean;
  realExecutionAuthorized: boolean;
  riskSteps: {
    sendAmount: "authorized" | "blocked";
    pressConfirm: "authorized" | "blocked";
    payPix: "manual_operator_action";
  };
  observation: ConversationObservation;
  relevantLogs: ParsedTailLogRecord[];
}>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function normalizeRealFlowEnvironment(value: string | undefined): TelegramRealFlowEnvironment {
  if (value === "test" || value === "production") {
    return value;
  }

  throw new Error("The --env option must be either 'test' or 'production'.");
}

export function buildRealFlowWorkerUrl(environment: TelegramRealFlowEnvironment): string {
  return TELEGRAM_REAL_FLOW_WORKER_HOSTS[environment];
}

export function buildTelegramWebhookUrl(environment: TelegramRealFlowEnvironment, tenantId: string): string {
  return `${buildRealFlowWorkerUrl(environment)}/telegram/${tenantId}/webhook`;
}

export function buildEulenWebhookUrl(environment: TelegramRealFlowEnvironment, tenantId: string): string {
  return `${buildRealFlowWorkerUrl(environment)}/webhooks/eulen/${tenantId}/deposit`;
}

export function parseCliFlags(argv: string[], supportedKeys: ReadonlySet<string>, booleanKeys: ReadonlySet<string>): CliFlagMap {
  const values = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith("--")) {
      throw new Error(`Unexpected positional argument '${current}'.`);
    }

    const key = current.slice(2);

    if (!supportedKeys.has(key)) {
      throw new Error(`Unsupported option '${current}'.`);
    }

    if (booleanKeys.has(key)) {
      values.set(key, true);
      continue;
    }

    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      throw new Error(`Option '${current}' requires a value.`);
    }

    values.set(key, next);
    index += 1;
  }

  return values;
}

function readFlagText(flags: CliFlagMap, key: string): string | null {
  const value = flags.get(key);

  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInteger(value: string | null, fallback: number, label: string): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

export function readTelegramPreflightOptions(argv: string[], env: Record<string, string | undefined> = process.env): TelegramPreflightOptions {
  const flags = parseCliFlags(
    argv,
    new Set(["env", "tenant", "public-base-url", "ops-token-env", "out", "issue"]),
    new Set(),
  );
  const environment = normalizeRealFlowEnvironment(readFlagText(flags, "env") ?? "production");
  const tenantId = readFlagText(flags, "tenant") ?? "alpha";
  const publicBaseUrl = readFlagText(flags, "public-base-url") ?? buildRealFlowWorkerUrl(environment);
  const opsBearerEnv = readFlagText(flags, "ops-token-env") ?? "OPS_ROUTE_BEARER_TOKEN";
  const outputPath = readFlagText(flags, "out") ?? `artifacts/telegram-real-flow/preflight-${environment}-${tenantId}.json`;
  const issueNumber = readPositiveInteger(readFlagText(flags, "issue"), 546, "--issue");

  return {
    environment,
    tenantId,
    publicBaseUrl,
    opsBearerToken: env[opsBearerEnv]?.trim() || null,
    outputPath,
    issueNumber,
  };
}

export function readTelegramRealRunOptions(argv: string[]): TelegramRealRunOptions {
  const flags = parseCliFlags(
    argv,
    new Set([
      "env",
      "tenant",
      "amount-brl",
      "wallet",
      "out",
      "confirm-real",
      "require-payment-confirmed",
      "timeout-ms",
    ]),
    new Set(["confirm-real", "require-payment-confirmed"]),
  );
  const environment = normalizeRealFlowEnvironment(readFlagText(flags, "env") ?? "production");
  const tenantId = readFlagText(flags, "tenant") ?? "alpha";
  const amountBrl = readFlagText(flags, "amount-brl") ?? "";
  const walletAddress = readFlagText(flags, "wallet") ?? "";

  return {
    environment,
    tenantId,
    amountBrl,
    walletAddress,
    outputPath: readFlagText(flags, "out") ?? `artifacts/telegram-real-flow/real-run-${environment}-${tenantId}.json`,
    confirmReal: flags.get("confirm-real") === true,
    requirePaymentConfirmed: flags.get("require-payment-confirmed") === true,
    timeoutMs: readPositiveInteger(readFlagText(flags, "timeout-ms"), DEFAULT_REAL_FLOW_TIMEOUT_MS, "--timeout-ms"),
  };
}

function makeCheck(name: string, ok: boolean, input: Omit<PreflightCheck, "name" | "ok"> = {}): PreflightCheck {
  return {
    name,
    ok,
    ...input,
  };
}

export function evaluateTelegramPreflight(input: {
  options: TelegramPreflightOptions;
  health: Record<string, unknown> | null;
  webhookInfo: Record<string, unknown> | null;
  healthError?: string | null;
  webhookInfoError?: string | null;
  generatedAt?: string;
}): TelegramPreflightReport {
  const expectedWebhookUrl = `${input.options.publicBaseUrl}/telegram/${input.options.tenantId}/webhook`;
  const healthTenants = isObject(input.health?.configuration)
    && isObject(input.health.configuration.tenants)
    ? input.health.configuration.tenants
    : {};
  const tenantHealth = isObject(healthTenants[input.options.tenantId])
    ? healthTenants[input.options.tenantId] as Record<string, unknown>
    : null;
  const webhook = isObject(input.webhookInfo?.webhook) ? input.webhookInfo.webhook : {};
  const commands = Array.isArray(input.webhookInfo?.commands) ? input.webhookInfo.commands : [];
  const commandNames = commands
    .filter(isObject)
    .map((command) => readText(command.command))
    .filter((command): command is string => Boolean(command));
  const menuButton = isObject(input.webhookInfo?.menuButton) ? input.webhookInfo.menuButton : {};
  const checks = [
    makeCheck("ops_bearer_token_present", Boolean(input.options.opsBearerToken), {
      detail: input.options.opsBearerToken ? undefined : "Set OPS_ROUTE_BEARER_TOKEN or pass --ops-token-env.",
    }),
    makeCheck("health_available", Boolean(input.health) && input.health?.status === "ok", {
      expected: "ok",
      actual: input.health?.status ?? input.healthError ?? null,
    }),
    makeCheck("tenant_health_ready", Boolean(tenantHealth?.secretBindingsConfigured && tenantHealth?.splitConfigConfigured), {
      expected: { secretBindingsConfigured: true, splitConfigConfigured: true },
      actual: tenantHealth,
    }),
    makeCheck("telegram_webhook_info_available", Boolean(input.webhookInfo?.ok), {
      expected: true,
      actual: input.webhookInfo?.ok ?? input.webhookInfoError ?? null,
    }),
    makeCheck("telegram_webhook_url_canonical", webhook.url === expectedWebhookUrl, {
      expected: expectedWebhookUrl,
      actual: webhook.url ?? null,
    }),
    makeCheck("telegram_allowed_updates_include_callback_query", TELEGRAM_REAL_FLOW_ALLOWED_UPDATES.every((updateType) => readStringArray(webhook.allowedUpdates).includes(updateType)), {
      expected: TELEGRAM_REAL_FLOW_ALLOWED_UPDATES,
      actual: readStringArray(webhook.allowedUpdates),
    }),
    makeCheck("telegram_public_commands_registered", TELEGRAM_REAL_FLOW_PUBLIC_COMMANDS.every((command) => commandNames.includes(command)), {
      expected: TELEGRAM_REAL_FLOW_PUBLIC_COMMANDS,
      actual: commandNames,
    }),
    makeCheck("telegram_menu_button_commands", menuButton.type === "commands", {
      expected: "commands",
      actual: menuButton.type ?? null,
    }),
  ];
  const healthRequestId = readText(input.health?.requestId);

  return {
    kind: "telegram_real_flow_preflight",
    status: checks.every((check) => check.ok) ? "success" : "failure",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    environment: input.options.environment,
    tenantId: input.options.tenantId,
    publicBaseUrl: input.options.publicBaseUrl,
    checks,
    healthRequestId,
    expectedWebhookUrl,
  };
}

export function parseWranglerTailJsonObjects(output: string): unknown[] {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = output.slice(start, index + 1);
        try {
          objects.push(JSON.parse(candidate));
        } catch {
          // Ignore partial non-JSON output from wrangler banners.
        }
        start = -1;
      }
    }
  }

  return objects;
}

export function extractTailLogRecords(output: string): ParsedTailLogRecord[] {
  return parseWranglerTailJsonObjects(output).flatMap((entry) => {
    if (!isObject(entry) || !Array.isArray(entry.logs)) {
      return [];
    }

    return entry.logs.flatMap((logEntry) => {
      if (!isObject(logEntry) || !Array.isArray(logEntry.message)) {
        return [];
      }

      return logEntry.message.flatMap((message) => {
        if (typeof message !== "string") {
          return [];
        }

        try {
          const parsed = JSON.parse(message);
          return isObject(parsed) ? [parsed as ParsedTailLogRecord] : [];
        } catch {
          return [];
        }
      });
    });
  });
}

function collectDistinct(records: ParsedTailLogRecord[], read: (record: ParsedTailLogRecord) => string | null): string[] {
  return [...new Set(records.map(read).filter((value): value is string => Boolean(value)))];
}

export function summarizeConversationObservation(records: ParsedTailLogRecord[], options: Pick<TelegramRealRunOptions, "tenantId" | "requirePaymentConfirmed">): ConversationObservation {
  const tenantRecords = records.filter((record) => !record.tenantId || record.tenantId === options.tenantId);
  const sawStart = tenantRecords.some((record) => record.message === "telegram.update.received" && isObject(record.details?.update) && record.details.update.command === "/start");
  const sawReviewOrWalletStep = tenantRecords.some((record) => (
    record.message === "telegram.order.resumed"
    || record.message === "telegram.outbound.succeeded"
  ));
  const sawCallbackQuery = tenantRecords.some((record) => record.message === "telegram.update.received" && isObject(record.details?.update) && record.details.update.updateType === "callback_query");
  const sawCallbackConfirmation = tenantRecords.some((record) => record.message === "telegram.order.confirm_handled" && record.details?.source === "callback");
  const sawPixGenerated = tenantRecords.some((record) => (
    record.message === "telegram.order.confirm_handled"
    && record.details?.currentStep === "awaiting_payment"
    && Boolean(record.details?.depositEntryId)
  ));
  const sawPaymentConfirmed = tenantRecords.some((record) => (
    record.message === "telegram.payment_notification.sent"
    || (record.message === "webhook.eulen.processed" && record.details?.externalStatus === "depix_sent")
    || (record.message === "telegram.deposit_recheck.completed" && record.details?.externalStatus === "depix_sent")
  ));
  const sawEulenWebhook = tenantRecords.some((record) => typeof record.message === "string" && record.message.startsWith("webhook.eulen."));
  const orderIds = collectDistinct(tenantRecords, (record) => readText(record.details?.orderId));
  const depositEntryIds = collectDistinct(tenantRecords, (record) => readText(record.details?.depositEntryId));
  const sawSplitEvidence = tenantRecords.some((record) => (
    Boolean(record.details?.splitFee)
    || Boolean(record.details?.splitAddress)
    || (record.message === "webhook.eulen.processed" && Boolean(record.details?.externalStatus))
  ));
  const requiredChecks = [
    sawStart,
    sawCallbackQuery,
    sawCallbackConfirmation,
    sawPixGenerated,
    options.requirePaymentConfirmed ? sawPaymentConfirmed : true,
  ];
  const status = requiredChecks.every(Boolean) ? "success" : "failure";
  const reason = status === "success"
    ? null
    : [
      !sawStart ? "missing_start_command" : null,
      !sawCallbackQuery ? "missing_callback_query" : null,
      !sawCallbackConfirmation ? "missing_callback_confirmation" : null,
      !sawPixGenerated ? "missing_pix_generation" : null,
      options.requirePaymentConfirmed && !sawPaymentConfirmed ? "missing_payment_confirmation" : null,
    ].find(Boolean) ?? "unknown_failure";

  return {
    status,
    reason,
    requestIds: collectDistinct(tenantRecords, (record) => readText(record.requestId)),
    orderIds,
    depositEntryIds,
    sawStart,
    sawReviewOrWalletStep,
    sawCallbackQuery,
    sawCallbackConfirmation,
    sawPixGenerated,
    sawPaymentConfirmed,
    sawEulenWebhook,
    sawSplitEvidence,
  };
}

export function buildAbortedRealRunReport(options: TelegramRealRunOptions, generatedAt = new Date().toISOString()): TelegramRealRunReport {
  return {
    kind: "telegram_real_flow_real_run",
    status: "aborted",
    generatedAt,
    environment: options.environment,
    tenantId: options.tenantId,
    amountBrl: options.amountBrl,
    walletAddressProvided: options.walletAddress.length > 0,
    realExecutionAuthorized: false,
    riskSteps: {
      sendAmount: "blocked",
      pressConfirm: "blocked",
      payPix: "manual_operator_action",
    },
    observation: {
      status: "failure",
      reason: "real_execution_flag_missing",
      requestIds: [],
      orderIds: [],
      depositEntryIds: [],
      sawStart: false,
      sawReviewOrWalletStep: false,
      sawCallbackQuery: false,
      sawCallbackConfirmation: false,
      sawPixGenerated: false,
      sawPaymentConfirmed: false,
      sawEulenWebhook: false,
      sawSplitEvidence: false,
    },
    relevantLogs: [],
  };
}

export function buildRealRunReport(options: TelegramRealRunOptions, records: ParsedTailLogRecord[], generatedAt = new Date().toISOString()): TelegramRealRunReport {
  const observation = summarizeConversationObservation(records, options);

  return {
    kind: "telegram_real_flow_real_run",
    status: observation.status,
    generatedAt,
    environment: options.environment,
    tenantId: options.tenantId,
    amountBrl: options.amountBrl,
    walletAddressProvided: options.walletAddress.length > 0,
    realExecutionAuthorized: true,
    riskSteps: {
      sendAmount: "authorized",
      pressConfirm: "authorized",
      payPix: "manual_operator_action",
    },
    observation,
    relevantLogs: records.filter((record) => record.tenantId === options.tenantId || !record.tenantId),
  };
}

export async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  const absolutePath = resolve(path);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function fetchJson(input: { fetchFn: typeof fetch; url: string; headers?: HeadersInit }): Promise<{ body: Record<string, unknown> | null; error: string | null }> {
  try {
    const response = await input.fetchFn(input.url, {
      headers: input.headers,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        body: isObject(body) ? body : null,
        error: `HTTP ${response.status}`,
      };
    }

    return {
      body: isObject(body) ? body : null,
      error: null,
    };
  } catch (error) {
    return {
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildOperatorInstructions(options: TelegramRealRunOptions): string {
  return [
    "Execute no Telegram real enquanto este runner observa o wrangler tail:",
    `1. Abra o bot do tenant ${options.tenantId} em ${options.environment}.`,
    "2. Envie /start.",
    `3. Envie o valor BRL: ${options.amountBrl}.`,
    `4. Envie o endereço: ${options.walletAddress}.`,
    "5. Toque no botão Confirmar, não confirme por texto.",
    "6. Pague o Pix manualmente apenas se esta for a execução real autorizada.",
  ].join("\n");
}

export function startWranglerTail(input: { environment: TelegramRealFlowEnvironment; cwd: string }): ChildProcessWithoutNullStreams {
  return spawn("npx", ["wrangler", "tail", "--env", input.environment, "--format", "json"], {
    cwd: input.cwd,
    shell: process.platform === "win32",
  });
}
