#!/usr/bin/env node
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  buildEulenWebhookUrl,
  buildRealFlowWorkerUrl,
  fetchJson,
  parseCliFlags,
  TELEGRAM_REAL_FLOW_ALLOWED_UPDATES,
  TELEGRAM_REAL_FLOW_PUBLIC_COMMANDS,
  type PreflightCheck,
  type TelegramRealFlowEnvironment,
  writeJsonArtifact,
} from "./lib/telegram-real-flow.js";

type ReleasePreflightStatus = "ready_for_live_purchase" | "failed";

export type ReleasePreflightOptions = Readonly<{
  environment: TelegramRealFlowEnvironment;
  tenantId: string;
  baseUrl: string;
  opsBearerToken: string | null;
  outputPath: string;
  eulenWebhookOperatorConfirmed: boolean;
}>;

export type ReleasePreflightReport = Readonly<{
  kind: "release_0_1_preflight";
  generatedAt: string;
  environment: TelegramRealFlowEnvironment;
  tenantId: string;
  baseUrl: string;
  commitSha: string;
  health: {
    ok: boolean;
    requestId: string | null;
  };
  telegramWebhook: {
    ok: boolean;
    expectedUrl: string;
    actualUrl: string | null;
  };
  eulenWebhook: {
    expectedUrl: string;
    operatorConfirmed: boolean;
  };
  eulenPing: {
    ok: boolean;
    available: boolean;
    skipped: boolean;
    reason: string | null;
  };
  checks: PreflightCheck[];
  finalStatus: ReleasePreflightStatus;
  failureReason?: string;
}>;

type ReleasePreflightInput = Readonly<{
  options: ReleasePreflightOptions;
  health: Record<string, unknown> | null;
  healthError?: string | null;
  telegramWebhookInfo: Record<string, unknown> | null;
  telegramWebhookInfoError?: string | null;
  eulenPing: Record<string, unknown> | null;
  eulenPingError?: string | null;
  generatedAt?: string;
  commitSha?: string;
}>;

type Runtime = Readonly<{
  fetchFn: typeof fetch;
  generatedAt?: string;
  commitSha?: string;
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

function readBooleanEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "sim"].includes(String(value ?? "").trim().toLowerCase());
}

function readFlagText(flags: ReadonlyMap<string, string | true>, key: string): string | null {
  const value = flags.get(key);

  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeEnvironment(value: string | null): TelegramRealFlowEnvironment {
  if (value === "test" || value === "production") {
    return value;
  }

  if (!value) {
    return "production";
  }

  throw new Error("--env must be either test or production.");
}

function buildTimestampForPath(date = new Date()): string {
  return date.toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}

function buildDefaultOutputPath(environment: TelegramRealFlowEnvironment, tenantId: string, generatedAt: string): string {
  const suffix = generatedAt.replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");

  return `artifacts/release-0.1/preflight-${tenantId}-${environment}-${suffix}.json`;
}

export function readReleasePreflightOptions(argv: string[], env: Record<string, string | undefined> = process.env): ReleasePreflightOptions {
  const flags = parseCliFlags(
    argv,
    new Set(["env", "tenant", "public-base-url", "ops-token-env", "out", "eulen-webhook-confirmed-env", "operator-confirmed-eulen-webhook"]),
    new Set(["operator-confirmed-eulen-webhook"]),
  );
  const environment = normalizeEnvironment(readFlagText(flags, "env"));
  const tenantId = readFlagText(flags, "tenant") ?? "alpha";
  const baseUrl = readFlagText(flags, "public-base-url") ?? buildRealFlowWorkerUrl(environment);
  const opsTokenEnv = readFlagText(flags, "ops-token-env") ?? "OPS_ROUTE_BEARER_TOKEN";
  const eulenWebhookConfirmedEnv = readFlagText(flags, "eulen-webhook-confirmed-env") ?? "EULEN_WEBHOOK_OPERATOR_CONFIRMED";
  const generatedAt = buildTimestampForPath();
  const eulenWebhookOperatorConfirmed = flags.get("operator-confirmed-eulen-webhook") === true
    || readBooleanEnv(env[eulenWebhookConfirmedEnv]);

  return {
    environment,
    tenantId,
    baseUrl,
    opsBearerToken: env[opsTokenEnv]?.trim() || null,
    outputPath: readFlagText(flags, "out") ?? buildDefaultOutputPath(environment, tenantId, generatedAt),
    eulenWebhookOperatorConfirmed,
  };
}

function makeCheck(name: string, ok: boolean, input: Omit<PreflightCheck, "name" | "ok"> = {}): PreflightCheck {
  return {
    name,
    ok,
    ...input,
  };
}

function getTenantHealth(health: Record<string, unknown> | null, tenantId: string): Record<string, unknown> | null {
  if (!isObject(health?.configuration) || !isObject(health.configuration.tenants)) {
    return null;
  }

  const tenantHealth = health.configuration.tenants[tenantId];

  return isObject(tenantHealth) ? tenantHealth : null;
}

function readTelegramWebhook(input: Record<string, unknown> | null): Record<string, unknown> {
  return isObject(input?.webhook) ? input.webhook : {};
}

function readTelegramCommandNames(input: Record<string, unknown> | null): string[] {
  const commands = Array.isArray(input?.commands) ? input.commands : [];

  return commands
    .filter(isObject)
    .map((command) => readText(command.command))
    .filter((command): command is string => Boolean(command));
}

function readTelegramMenuButton(input: Record<string, unknown> | null): Record<string, unknown> {
  return isObject(input?.menuButton) ? input.menuButton : {};
}

function isUnavailableEulenDiagnostic(body: Record<string, unknown> | null, error: string | null | undefined): boolean {
  return error === "HTTP 404" && body?.error === "diagnostic_route_unavailable";
}

function buildFailureReason(checks: PreflightCheck[]): string | undefined {
  const firstFailedCheck = checks.find((check) => !check.ok);

  if (!firstFailedCheck) {
    return undefined;
  }

  return firstFailedCheck.detail
    ? `${firstFailedCheck.name}: ${firstFailedCheck.detail}`
    : firstFailedCheck.name;
}

function readCurrentCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function evaluateReleasePreflight(input: ReleasePreflightInput): ReleasePreflightReport {
  const expectedTelegramWebhookUrl = `${input.options.baseUrl}/telegram/${input.options.tenantId}/webhook`;
  const expectedEulenWebhookUrl = buildEulenWebhookUrl(input.options.environment, input.options.tenantId);
  const tenantHealth = getTenantHealth(input.health, input.options.tenantId);
  const webhook = readTelegramWebhook(input.telegramWebhookInfo);
  const commandNames = readTelegramCommandNames(input.telegramWebhookInfo);
  const menuButton = readTelegramMenuButton(input.telegramWebhookInfo);
  const actualTelegramWebhookUrl = readText(webhook.url);
  const eulenDiagnosticUnavailable = isUnavailableEulenDiagnostic(input.eulenPing, input.eulenPingError);
  const eulenPingOk = Boolean(input.eulenPing?.ok) || eulenDiagnosticUnavailable;
  const checks = [
    makeCheck("ops_bearer_token_present", Boolean(input.options.opsBearerToken), {
      detail: input.options.opsBearerToken ? undefined : "Set OPS_ROUTE_BEARER_TOKEN or pass --ops-token-env before live validation.",
    }),
    makeCheck("health_available", Boolean(input.health) && input.health?.status === "ok", {
      expected: "ok",
      actual: input.health?.status ?? input.healthError ?? null,
    }),
    makeCheck("tenant_runtime_ready", Boolean(
      tenantHealth?.secretBindingsConfigured
      && tenantHealth?.splitConfigConfigured
      && tenantHealth?.eulenPartnerConfigured,
    ), {
      expected: {
        secretBindingsConfigured: true,
        splitConfigConfigured: true,
        eulenPartnerConfigured: true,
      },
      actual: tenantHealth,
    }),
    makeCheck("telegram_webhook_info_available", Boolean(input.telegramWebhookInfo?.ok), {
      expected: true,
      actual: input.telegramWebhookInfo?.ok ?? input.telegramWebhookInfoError ?? null,
      detail: input.options.opsBearerToken ? undefined : "Skipped because the ops bearer token is missing.",
    }),
    makeCheck("telegram_webhook_url_canonical", actualTelegramWebhookUrl === expectedTelegramWebhookUrl, {
      expected: expectedTelegramWebhookUrl,
      actual: actualTelegramWebhookUrl,
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
    makeCheck("eulen_webhook_operator_confirmed", input.options.eulenWebhookOperatorConfirmed, {
      expected: true,
      actual: input.options.eulenWebhookOperatorConfirmed,
      detail: input.options.eulenWebhookOperatorConfirmed
        ? undefined
        : "Confirm the Eulen deposit webhook registration out-of-band before live purchase.",
    }),
    makeCheck("eulen_ping_available_when_enabled", eulenPingOk, {
      expected: true,
      actual: input.eulenPing?.ok ?? input.eulenPingError ?? null,
      detail: eulenDiagnosticUnavailable ? "Skipped because remote Eulen diagnostics are not enabled." : undefined,
    }),
  ];
  const failureReason = buildFailureReason(checks);

  return {
    kind: "release_0_1_preflight",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    environment: input.options.environment,
    tenantId: input.options.tenantId,
    baseUrl: input.options.baseUrl,
    commitSha: input.commitSha ?? readCurrentCommitSha(),
    health: {
      ok: Boolean(input.health) && input.health?.status === "ok",
      requestId: readText(input.health?.requestId),
    },
    telegramWebhook: {
      ok: Boolean(input.telegramWebhookInfo?.ok),
      expectedUrl: expectedTelegramWebhookUrl,
      actualUrl: actualTelegramWebhookUrl,
    },
    eulenWebhook: {
      expectedUrl: expectedEulenWebhookUrl,
      operatorConfirmed: input.options.eulenWebhookOperatorConfirmed,
    },
    eulenPing: {
      ok: eulenPingOk,
      available: Boolean(input.eulenPing?.ok),
      skipped: eulenDiagnosticUnavailable,
      reason: eulenDiagnosticUnavailable ? "diagnostic_route_unavailable" : input.eulenPingError ?? null,
    },
    checks,
    finalStatus: failureReason ? "failed" : "ready_for_live_purchase",
    ...(failureReason ? { failureReason } : {}),
  };
}

export async function runReleasePreflight(options: ReleasePreflightOptions, runtime: Runtime = { fetchFn: fetch }): Promise<ReleasePreflightReport> {
  const healthUrl = `${options.baseUrl}/health`;
  const healthResult = await fetchJson({ fetchFn: runtime.fetchFn, url: healthUrl });
  const missingOpsToken = !options.opsBearerToken;
  const telegramWebhookInfoUrl = `${options.baseUrl}/ops/${options.tenantId}/telegram/webhook-info?publicBaseUrl=${encodeURIComponent(options.baseUrl)}`;
  const eulenPingUrl = `${options.baseUrl}/ops/${options.tenantId}/eulen/ping?asyncMode=true`;
  const telegramWebhookInfoResult = missingOpsToken
    ? { body: null, error: "missing_ops_bearer_token" }
    : await fetchJson({
      fetchFn: runtime.fetchFn,
      url: telegramWebhookInfoUrl,
      headers: {
        authorization: `Bearer ${options.opsBearerToken}`,
      },
    });
  const eulenPingResult = missingOpsToken
    ? { body: null, error: "skipped_missing_ops_bearer_token" }
    : await fetchJson({ fetchFn: runtime.fetchFn, url: eulenPingUrl });

  return evaluateReleasePreflight({
    options,
    health: healthResult.body,
    healthError: healthResult.error,
    telegramWebhookInfo: telegramWebhookInfoResult.body,
    telegramWebhookInfoError: telegramWebhookInfoResult.error,
    eulenPing: eulenPingResult.body,
    eulenPingError: eulenPingResult.error,
    generatedAt: runtime.generatedAt,
    commitSha: runtime.commitSha,
  });
}

async function main(argv: string[]): Promise<number> {
  const options = readReleasePreflightOptions(argv, process.env);
  const report = await runReleasePreflight(options);

  await writeJsonArtifact(options.outputPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (report.finalStatus !== "ready_for_live_purchase") {
    process.stderr.write(`Release 0.1 preflight failed. Evidence: ${options.outputPath}\n`);
    return 1;
  }

  process.stdout.write(`Release 0.1 preflight passed. Evidence: ${options.outputPath}\n`);
  return 0;
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  process.exitCode = await main(process.argv.slice(2));
}
