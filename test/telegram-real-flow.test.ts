import { describe, expect, it } from "vitest";

import {
  buildAbortedRealRunReport,
  buildEulenWebhookUrl,
  buildRealRunReport,
  buildTelegramWebhookUrl,
  evaluateTelegramPreflight,
  extractTailLogRecords,
  readTelegramPreflightOptions,
  readTelegramRealRunOptions,
} from "../scripts/lib/telegram-real-flow.js";

describe("telegram real-flow operational helpers", () => {
  it("parses preflight options without exposing the bearer token in flags", () => {
    const options = readTelegramPreflightOptions([
      "--env",
      "production",
      "--tenant",
      "alpha",
      "--out",
      "artifacts/preflight.json",
    ], {
      OPS_ROUTE_BEARER_TOKEN: "ops-token",
    });

    expect(options).toEqual({
      environment: "production",
      tenantId: "alpha",
      publicBaseUrl: "https://depix-mvp-production.dev865077.workers.dev",
      opsBearerToken: "ops-token",
      outputPath: "artifacts/preflight.json",
      issueNumber: 546,
    });
  });

  it("builds canonical Telegram and Eulen webhook URLs", () => {
    expect(buildTelegramWebhookUrl("production", "alpha")).toBe(
      "https://depix-mvp-production.dev865077.workers.dev/telegram/alpha/webhook",
    );
    expect(buildEulenWebhookUrl("production", "alpha")).toBe(
      "https://depix-mvp-production.dev865077.workers.dev/webhooks/eulen/alpha/deposit",
    );
  });

  it("fails preflight when callback_query is not enabled", () => {
    const options = readTelegramPreflightOptions(["--env", "production"], {
      OPS_ROUTE_BEARER_TOKEN: "ops-token",
    });
    const report = evaluateTelegramPreflight({
      options,
      generatedAt: "2026-04-21T23:50:00.000Z",
      health: {
        status: "ok",
        requestId: "health-request",
        configuration: {
          tenants: {
            alpha: {
              secretBindingsConfigured: true,
              splitConfigConfigured: true,
            },
          },
        },
      },
      webhookInfo: {
        ok: true,
        webhook: {
          url: "https://depix-mvp-production.dev865077.workers.dev/telegram/alpha/webhook",
          allowedUpdates: ["message"],
        },
        commands: [
          { command: "start", description: "Começar uma compra" },
          { command: "help", description: "Ver ajuda do fluxo" },
          { command: "status", description: "Ver pedido atual" },
          { command: "cancel", description: "Cancelar pedido aberto" },
        ],
        menuButton: {
          type: "commands",
        },
      },
    });

    expect(report.status).toBe("failure");
    expect(report.checks.find((check) => check.name === "telegram_allowed_updates_include_callback_query")).toMatchObject({
      ok: false,
      expected: ["message", "callback_query"],
      actual: ["message"],
    });
  });

  it("passes preflight when webhook, commands and menu are canonical", () => {
    const options = readTelegramPreflightOptions(["--env", "test", "--tenant", "beta"], {
      OPS_ROUTE_BEARER_TOKEN: "ops-token",
    });
    const report = evaluateTelegramPreflight({
      options,
      generatedAt: "2026-04-21T23:55:00.000Z",
      health: {
        status: "ok",
        configuration: {
          tenants: {
            beta: {
              secretBindingsConfigured: true,
              splitConfigConfigured: true,
            },
          },
        },
      },
      webhookInfo: {
        ok: true,
        webhook: {
          url: "https://depix-mvp-test.dev865077.workers.dev/telegram/beta/webhook",
          allowedUpdates: ["message", "callback_query"],
        },
        commands: [
          { command: "start", description: "Começar uma compra" },
          { command: "help", description: "Ver ajuda do fluxo" },
          { command: "status", description: "Ver pedido atual" },
          { command: "cancel", description: "Cancelar pedido aberto" },
        ],
        menuButton: {
          type: "commands",
        },
      },
    });

    expect(report.status).toBe("success");
  });

  it("blocks real run without the explicit real execution flag", () => {
    const options = readTelegramRealRunOptions([
      "--env",
      "production",
      "--amount-brl",
      "3",
      "--wallet",
      "lq1wallet",
    ]);
    const report = buildAbortedRealRunReport(options, "2026-04-22T00:00:00.000Z");

    expect(report.status).toBe("aborted");
    expect(report.realExecutionAuthorized).toBe(false);
    expect(report.riskSteps.sendAmount).toBe("blocked");
    expect(report.observation.reason).toBe("real_execution_flag_missing");
  });

  it("extracts structured records from pretty wrangler tail JSON", () => {
    const output = `noise
{
  "logs": [
    {
      "message": [
        "{\\"timestamp\\":\\"2026-04-22T00:00:01.000Z\\",\\"message\\":\\"telegram.update.received\\",\\"tenantId\\":\\"alpha\\",\\"requestId\\":\\"r1\\",\\"details\\":{\\"update\\":{\\"updateType\\":\\"callback_query\\"}}}"
      ]
    }
  ]
}
more noise`;

    expect(extractTailLogRecords(output)).toEqual([
      {
        timestamp: "2026-04-22T00:00:01.000Z",
        message: "telegram.update.received",
        tenantId: "alpha",
        requestId: "r1",
        details: {
          update: {
            updateType: "callback_query",
          },
        },
      },
    ]);
  });

  it("summarizes a successful real run from observed production logs", () => {
    const options = readTelegramRealRunOptions([
      "--env",
      "production",
      "--tenant",
      "alpha",
      "--amount-brl",
      "3",
      "--wallet",
      "lq1wallet",
      "--confirm-real",
      "--require-payment-confirmed",
    ]);
    const report = buildRealRunReport(options, [
      {
        message: "telegram.update.received",
        tenantId: "alpha",
        requestId: "r-start",
        details: {
          update: {
            command: "/start",
          },
        },
      },
      {
        message: "telegram.update.received",
        tenantId: "alpha",
        requestId: "r-callback",
        details: {
          update: {
            updateType: "callback_query",
          },
        },
      },
      {
        message: "telegram.order.confirm_handled",
        tenantId: "alpha",
        requestId: "r-callback",
        details: {
          source: "callback",
          currentStep: "awaiting_payment",
          orderId: "order_1",
          depositEntryId: "deposit_1",
        },
      },
      {
        message: "webhook.eulen.processed",
        tenantId: "alpha",
        requestId: "r-eulen",
        details: {
          orderId: "order_1",
          depositEntryId: "deposit_1",
          externalStatus: "depix_sent",
        },
      },
    ], "2026-04-22T00:05:00.000Z");

    expect(report.status).toBe("success");
    expect(report.observation).toMatchObject({
      sawCallbackQuery: true,
      sawCallbackConfirmation: true,
      sawPixGenerated: true,
      sawPaymentConfirmed: true,
      orderIds: ["order_1"],
      depositEntryIds: ["deposit_1"],
    });
  });
});

