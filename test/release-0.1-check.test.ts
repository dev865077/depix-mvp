import { describe, expect, it, vi } from "vitest";

import {
  evaluateReleasePreflight,
  readReleasePreflightOptions,
  runReleasePreflight,
  type ReleasePreflightOptions,
} from "../scripts/release-0.1-check";

const baseOptions: ReleasePreflightOptions = {
  environment: "production",
  tenantId: "alpha",
  baseUrl: "https://depix-mvp-production.dev865077.workers.dev",
  opsBearerToken: "ops-token",
  outputPath: "artifacts/release-0.1/preflight-alpha-production.json",
  eulenWebhookOperatorConfirmed: true,
};

const healthyHealth = {
  status: "ok",
  requestId: "req_123",
  configuration: {
    tenants: {
      alpha: {
        tenantId: "alpha",
        secretBindingsConfigured: true,
        splitConfigConfigured: true,
        eulenPartnerConfigured: true,
      },
    },
  },
};

const healthyTelegramWebhookInfo = {
  ok: true,
  webhook: {
    url: "https://depix-mvp-production.dev865077.workers.dev/telegram/alpha/webhook",
    allowedUpdates: ["message", "callback_query"],
  },
  commands: [
    { command: "start" },
    { command: "help" },
    { command: "status" },
    { command: "cancel" },
  ],
  menuButton: {
    type: "commands",
  },
};

describe("release 0.1 preflight", () => {
  it("marks the release ready when health, Telegram and operator confirmation are aligned", () => {
    const report = evaluateReleasePreflight({
      options: baseOptions,
      health: healthyHealth,
      telegramWebhookInfo: healthyTelegramWebhookInfo,
      eulenPing: { ok: true },
      generatedAt: "2026-04-23T01:00:00.000Z",
      commitSha: "abc123",
    });

    expect(report.finalStatus).toBe("ready_for_live_purchase");
    expect(report.health.ok).toBe(true);
    expect(report.telegramWebhook.ok).toBe(true);
    expect(report.eulenWebhook).toEqual({
      expectedUrl: "https://depix-mvp-production.dev865077.workers.dev/webhooks/eulen/alpha/deposit",
      operatorConfirmed: true,
    });
    expect(report.failureReason).toBeUndefined();
  });

  it("fails safely before ops checks when the operator token is missing", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe("https://depix-mvp-production.dev865077.workers.dev/health");

      return Response.json(healthyHealth);
    });

    const report = await runReleasePreflight({
      ...baseOptions,
      opsBearerToken: null,
    }, {
      fetchFn: fetchFn as unknown as typeof fetch,
      generatedAt: "2026-04-23T01:00:00.000Z",
      commitSha: "abc123",
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(report.finalStatus).toBe("failed");
    expect(report.failureReason).toContain("ops_bearer_token_present");
    expect(report.telegramWebhook.ok).toBe(false);
  });

  it("requires explicit Eulen webhook operator confirmation before live purchase", () => {
    const report = evaluateReleasePreflight({
      options: {
        ...baseOptions,
        eulenWebhookOperatorConfirmed: false,
      },
      health: healthyHealth,
      telegramWebhookInfo: healthyTelegramWebhookInfo,
      eulenPing: { ok: true },
      generatedAt: "2026-04-23T01:00:00.000Z",
      commitSha: "abc123",
    });

    expect(report.finalStatus).toBe("failed");
    expect(report.failureReason).toContain("eulen_webhook_operator_confirmed");
  });

  it("treats unavailable remote Eulen diagnostics as a documented skip", () => {
    const report = evaluateReleasePreflight({
      options: baseOptions,
      health: healthyHealth,
      telegramWebhookInfo: healthyTelegramWebhookInfo,
      eulenPing: { error: "diagnostic_route_unavailable" },
      eulenPingError: "HTTP 404",
      generatedAt: "2026-04-23T01:00:00.000Z",
      commitSha: "abc123",
    });

    expect(report.finalStatus).toBe("ready_for_live_purchase");
    expect(report.eulenPing).toEqual({
      ok: true,
      available: false,
      skipped: true,
      reason: "diagnostic_route_unavailable",
    });
  });

  it("reads production alpha defaults and the confirmation env var", () => {
    const options = readReleasePreflightOptions([], {
      OPS_ROUTE_BEARER_TOKEN: "ops-token",
      EULEN_WEBHOOK_OPERATOR_CONFIRMED: "true",
    });

    expect(options.environment).toBe("production");
    expect(options.tenantId).toBe("alpha");
    expect(options.baseUrl).toBe("https://depix-mvp-production.dev865077.workers.dev");
    expect(options.opsBearerToken).toBe("ops-token");
    expect(options.eulenWebhookOperatorConfirmed).toBe(true);
    expect(options.outputPath).toMatch(/^artifacts\/release-0\.1\/preflight-alpha-production-/);
  });
});
