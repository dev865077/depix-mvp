import { describe, expect, it } from "vitest";

import {
  buildSplitProofReport,
  buildD1ExecuteArgs,
  buildDeploymentStatusArgs,
  buildHealthUrl,
  buildLatestDepositEventsQuery,
  buildLatestDepositsQuery,
  buildLatestOrdersQuery,
  buildMigrationsListArgs,
  buildOpsReadinessReport,
  DEFAULT_OPERATION_TIMEOUT_MS,
  formatEvidenceMarkdown,
  parseD1ExecuteJsonOutput,
  readEvidenceCliOptions,
  resolveWranglerInvocation,
  runQrFlowEvidenceCli,
} from "../scripts/lib/qr-flow-evidence.js";

describe("qr flow evidence helpers", () => {
  it("parses the supported CLI options conservatively", function assertCliOptionParsing() {
    const options = readEvidenceCliOptions([
      "--env",
      "production",
      "--tenant",
      "beta",
      "--since",
      "2026-04-19T02:00:00Z",
      "--limit",
      "3",
      "--order-id",
      "order_123",
      "--deposit-entry-id",
      "deposit_123",
      "--issue",
      "90",
    ]);

    expect(options).toEqual({
      environment: "production",
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      orderId: "order_123",
      depositEntryId: "deposit_123",
      limit: 3,
      issueNumber: 90,
      requireSplitProof: false,
    });
  });

  it("parses the split proof release gate as an explicit flag", function assertSplitProofFlagParsing() {
    const options = readEvidenceCliOptions([
      "--env",
      "test",
      "--require-split-proof",
    ]);

    expect(options.requireSplitProof).toBe(true);
  });

  it("uses the canonical public health hosts for remote environments", function assertHealthUrlMapping() {
    expect(buildHealthUrl("test")).toBe("https://depix-mvp-test.dev865077.workers.dev/health");
    expect(buildHealthUrl("production")).toBe("https://depix-mvp-production.dev865077.workers.dev/health");
  });

  it("builds SQL filtered by tenant and timeframe", function assertQueryFilters() {
    const ordersQuery = buildLatestOrdersQuery({
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      orderId: "order_123",
      depositEntryId: "deposit_123",
      limit: 2,
    });
    const depositsQuery = buildLatestDepositsQuery({
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      orderId: "order_123",
      depositEntryId: "deposit_123",
      limit: 2,
    });
    const eventsQuery = buildLatestDepositEventsQuery({
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      orderId: "order_123",
      depositEntryId: "deposit_123",
      limit: 2,
    });

    expect(ordersQuery).toContain("o.channel = 'telegram'");
    expect(ordersQuery).toContain("o.tenant_id = 'beta'");
    expect(ordersQuery).toContain("o.order_id = 'order_123'");
    expect(ordersQuery).toContain("d.deposit_entry_id = 'deposit_123'");
    expect(ordersQuery).toContain("o.telegram_chat_id");
    expect(ordersQuery).toContain("o.split_address");
    expect(ordersQuery).toContain("o.split_fee");
    expect(ordersQuery).toContain("julianday(o.updated_at) >= julianday('2026-04-19T02:00:00Z')");
    expect(ordersQuery).toContain("LIMIT 2;");
    expect(depositsQuery).toContain("INNER JOIN orders o ON o.order_id = d.order_id");
    expect(depositsQuery).toContain("d.tenant_id = 'beta'");
    expect(depositsQuery).toContain("d.order_id = 'order_123'");
    expect(depositsQuery).toContain("d.deposit_entry_id = 'deposit_123'");
    expect(depositsQuery).toContain("julianday(d.updated_at) >= julianday('2026-04-19T02:00:00Z')");
    expect(depositsQuery).toContain("LIMIT 2;");
    expect(eventsQuery).toContain("FROM deposit_events e");
    expect(eventsQuery).toContain("INNER JOIN orders o ON o.tenant_id = e.tenant_id AND o.order_id = e.order_id");
    expect(eventsQuery).toContain("e.tenant_id = 'beta'");
    expect(eventsQuery).toContain("e.order_id = 'order_123'");
    expect(eventsQuery).toContain("e.deposit_entry_id = 'deposit_123'");
    expect(eventsQuery).toContain("julianday(e.received_at) >= julianday('2026-04-19T02:00:00Z')");
    expect(eventsQuery).not.toContain("raw_payload");
    expect(eventsQuery).toContain("ORDER BY julianday(e.received_at) DESC, e.id DESC");
    expect(eventsQuery).toContain("LIMIT 2;");
  });

  it("keeps broad deposit event evidence correlated to local deposits unless an explicit filter is used", function assertDepositEventCorrelationSafety() {
    const broadQuery = buildLatestDepositEventsQuery({
      tenantId: null,
      sinceIso: null,
      orderId: null,
      depositEntryId: null,
      limit: 5,
    });
    const explicitQuery = buildLatestDepositEventsQuery({
      tenantId: null,
      sinceIso: null,
      orderId: null,
      depositEntryId: "deposit_123",
      limit: 5,
    });

    expect(broadQuery).toContain("EXISTS (");
    expect(broadQuery).toContain("FROM deposits d");
    expect(explicitQuery).not.toContain("EXISTS (");
    expect(explicitQuery).toContain("e.deposit_entry_id = 'deposit_123'");
  });

  it("derives redacted ops readiness from health without preserving extra fields", function assertOpsReadinessRedaction() {
    const readiness = buildOpsReadinessReport({
      configuration: {
        operations: {
          depositRecheck: {
            state: "ready",
            ready: true,
            bearerToken: "must-not-render",
          },
          depositsFallback: {
            state: "disabled",
            ready: false,
            tenantOverrides: {
              configured: ["alpha"],
            },
          },
        },
      },
    });

    expect(readiness).toEqual({
      depositRecheck: {
        state: "ready",
        ready: true,
      },
      depositsFallback: {
        state: "disabled",
        ready: false,
      },
    });
    expect(JSON.stringify(readiness)).not.toContain("must-not-render");
    expect(JSON.stringify(readiness)).not.toContain("tenantOverrides");
  });

  it("keeps backward compatibility with older health payloads that exposed operations at the root", function assertLegacyOpsReadinessCompatibility() {
    const readiness = buildOpsReadinessReport({
      operations: {
        depositRecheck: {
          state: "ready",
          ready: true,
        },
        depositsFallback: {
          state: "ready",
          ready: true,
        },
      },
    });

    expect(readiness).toEqual({
      depositRecheck: {
        state: "ready",
        ready: true,
      },
      depositsFallback: {
        state: "ready",
        ready: true,
      },
    });
  });

  it("marks split proof as missing onchain tx when only the fiat-side trace exists", function assertSplitProofGap() {
    expect(buildSplitProofReport(
      [
        {
          order_id: "order_1",
          split_address: "lq1split",
          split_fee: "1.00%",
        },
      ],
      [
        {
          order_id: "order_1",
          external_status: "depix_sent",
        },
      ],
      [
        {
          order_id: "order_1",
          bank_tx_id: "fitbank_123",
          blockchain_tx_id: null,
        },
      ],
    )).toEqual({
      status: "missing_onchain_tx",
      orderIds: ["order_1"],
      bankTxIds: ["fitbank_123"],
      blockchainTxIds: [],
      splitConfiguredOrders: 1,
      settledOrders: 1,
    });
  });

  it("marks split proof as proved when an onchain tx id exists", function assertSplitProofProved() {
    expect(buildSplitProofReport(
      [
        {
          order_id: "order_1",
          split_address: "lq1split",
          split_fee: "1.00%",
        },
      ],
      [
        {
          order_id: "order_1",
          external_status: "depix_sent",
        },
      ],
      [
        {
          order_id: "order_1",
          bank_tx_id: "fitbank_123",
          blockchain_tx_id: "liquid_tx_123",
        },
      ],
    )).toEqual({
      status: "proved",
      orderIds: ["order_1"],
      bankTxIds: ["fitbank_123"],
      blockchainTxIds: ["liquid_tx_123"],
      splitConfiguredOrders: 1,
      settledOrders: 1,
    });
  });

  it("does not mark split proof as proved from an unrelated order event", function assertSplitProofCorrelation() {
    expect(buildSplitProofReport(
      [
        {
          order_id: "order_target",
          split_address: "lq1split",
          split_fee: "1.00%",
        },
      ],
      [
        {
          order_id: "order_target",
          external_status: "depix_sent",
        },
      ],
      [
        {
          order_id: "order_target",
          bank_tx_id: "fitbank_target",
          blockchain_tx_id: null,
        },
        {
          order_id: "order_other",
          bank_tx_id: "fitbank_other",
          blockchain_tx_id: "liquid_tx_other",
        },
      ],
    )).toEqual({
      status: "missing_onchain_tx",
      orderIds: ["order_target"],
      bankTxIds: ["fitbank_target"],
      blockchainTxIds: [],
      splitConfiguredOrders: 1,
      settledOrders: 1,
    });
  });

  it("marks split proof as missing split config when the order never persisted split fields", function assertMissingSplitConfig() {
    expect(buildSplitProofReport(
      [
        {
          order_id: "order_1",
          split_address: null,
          split_fee: null,
        },
      ],
      [
        {
          order_id: "order_1",
          external_status: "pending",
        },
      ],
      [],
    )).toEqual({
      status: "missing_split_config",
      orderIds: ["order_1"],
      bankTxIds: [],
      blockchainTxIds: [],
      splitConfiguredOrders: 0,
      settledOrders: 0,
    });
  });

  it("builds the Wrangler command shapes used by the executable script", function assertWranglerCommandShapes() {
    const sql = "SELECT 1;";

    expect(DEFAULT_OPERATION_TIMEOUT_MS).toBe(30000);
    expect(buildDeploymentStatusArgs("production")).toEqual(["deployments", "status", "--env", "production"]);
    expect(buildMigrationsListArgs("production")).toEqual([
      "d1",
      "migrations",
      "list",
      "DB",
      "--remote",
      "--env",
      "production",
    ]);
    expect(buildD1ExecuteArgs("production", sql)).toEqual([
      "d1",
      "execute",
      "DB",
      "--remote",
      "--env",
      "production",
      "--json",
      "--command",
      sql,
    ]);
  });

  it("resolves Wrangler from env, local package, or PATH without assuming one install layout", function assertWranglerInvocationResolution() {
    const envInvocation = resolveWranglerInvocation({
      cwd: "/repo",
      platform: "linux",
      nodeBinary: "/node",
      env: {
        WRANGLER_BIN: "/custom/wrangler",
      },
      fileExists: () => false,
    });
    const localInvocation = resolveWranglerInvocation({
      cwd: "/repo",
      platform: "linux",
      nodeBinary: "/node",
      env: {},
      fileExists: (path) => path.endsWith("node_modules/wrangler/bin/wrangler.js"),
    });
    const windowsPathInvocation = resolveWranglerInvocation({
      cwd: "C:/repo",
      platform: "win32",
      nodeBinary: "node.exe",
      env: {},
      fileExists: () => false,
    });

    expect(envInvocation).toEqual({
      file: "/custom/wrangler",
      argsPrefix: [],
      source: "env",
    });
    expect(localInvocation.file).toBe("/node");
    expect(localInvocation.argsPrefix[0]).toContain("node_modules");
    expect(localInvocation.source).toBe("local-package");
    expect(windowsPathInvocation).toEqual({
      file: "wrangler.cmd",
      argsPrefix: [],
      source: "path",
    });
  });

  it("parses Wrangler D1 JSON output without masking malformed responses", function assertD1JsonParsing() {
    const validOutput = JSON.stringify([
      {
        results: [
          {
            order_id: "order_1",
          },
        ],
      },
    ]);

    expect(parseD1ExecuteJsonOutput(validOutput)).toEqual([
      {
        order_id: "order_1",
      },
    ]);
    expect(() => parseD1ExecuteJsonOutput("wrangler warning\n[]")).toThrow("not valid JSON");
    expect(() => parseD1ExecuteJsonOutput(JSON.stringify([]))).toThrow("did not include a results array");
    expect(() => parseD1ExecuteJsonOutput(JSON.stringify([{ results: null }]))).toThrow("non-array results");
  });

  it("runs the executable CLI path with injected Wrangler, git, and health boundaries", async function assertRunnableCliPath() {
    /** @type {Array<{ file: string, args: string[], options: Record<string, unknown> }>} */
    const calls = [];
    const output = {
      stdout: "",
      stderr: "",
    };
    const writableStdout = {
      write(chunk) {
        output.stdout += chunk;
        return true;
      },
    };
    const writableStderr = {
      write(chunk) {
        output.stderr += chunk;
        return true;
      },
    };
    const execFileSync = (file, args, options) => {
      calls.push({ file, args, options });

      if (file === "git") {
        return "commit_cli\n";
      }

      if (args[0] === "deployments") {
        return "Current Version ID: version_cli";
      }

      if (args[0] === "d1" && args[1] === "migrations") {
        return "No migrations to apply!";
      }

      if (args[0] === "d1" && args[1] === "execute") {
        return JSON.stringify([
          {
            results: [
              {
                order_id: "order_cli",
              },
            ],
          },
        ]);
      }

      throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
    };
    const fetchImplementation = async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        url,
      }),
    });

    const exitCode = await runQrFlowEvidenceCli({
      argv: ["--env", "production", "--tenant", "beta", "--limit", "1"],
      cwd: "/repo",
      platform: "linux",
      nodeBinary: "node-test",
      env: {
        WRANGLER_BIN: "wrangler-test",
      },
      fileExists: () => false,
      execFileSync,
      fetch: fetchImplementation,
      now: () => new Date("2026-04-19T13:00:00.000Z"),
      stdout: writableStdout,
      stderr: writableStderr,
    });

    expect(exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("## Evidencia controlada - issue #90");
    expect(output.stdout).toContain("commit_cli");
    expect(output.stdout).toContain("\"order_id\": \"order_cli\"");
    expect(output.stdout).toContain("### Deposit events correlacionados");
    expect(output.stdout).toContain("### Ops readiness");
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "wrangler-test",
          args: ["deployments", "status", "--env", "production"],
        }),
        expect.objectContaining({
          file: "git",
          args: ["rev-parse", "HEAD"],
        }),
      ]),
    );
    expect(calls.filter((call) => call.file === "wrangler-test" && call.args[1] === "execute")).toHaveLength(3);
    expect(calls.every((call) => call.options.timeout === DEFAULT_OPERATION_TIMEOUT_MS)).toBe(true);
  });

  it("returns a failing exit code when required split proof is not proved", async function assertRequiredSplitProofGate() {
    const output = {
      stdout: "",
      stderr: "",
    };
    const writableStdout = {
      write(chunk) {
        output.stdout += chunk;
        return true;
      },
    };
    const writableStderr = {
      write(chunk) {
        output.stderr += chunk;
        return true;
      },
    };
    const execFileSync = (file, args) => {
      if (file === "git") {
        return "commit_cli\n";
      }

      if (args[0] === "deployments") {
        return "Current Version ID: version_cli";
      }

      if (args[0] === "d1" && args[1] === "migrations") {
        return "No migrations to apply!";
      }

      if (args[0] === "d1" && args[1] === "execute" && args.join(" ").includes("FROM orders")) {
        return JSON.stringify([
          {
            results: [
              {
                order_id: "order_cli",
                split_address: "lq1split",
                split_fee: "1.00%",
              },
            ],
          },
        ]);
      }

      if (args[0] === "d1" && args[1] === "execute" && args.join(" ").includes("FROM deposit_events e")) {
        return JSON.stringify([
          {
            results: [
              {
                order_id: "order_cli",
                bank_tx_id: "fitbank_cli",
                blockchain_tx_id: null,
              },
            ],
          },
        ]);
      }

      if (args[0] === "d1" && args[1] === "execute" && args.join(" ").includes("FROM deposits d")) {
        return JSON.stringify([
          {
            results: [
              {
                order_id: "order_cli",
                external_status: "depix_sent",
              },
            ],
          },
        ]);
      }

      if (args[0] === "d1" && args[1] === "execute") {
        return JSON.stringify([
          {
            results: [],
          },
        ]);
      }

      throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
    };

    const exitCode = await runQrFlowEvidenceCli({
      argv: ["--env", "test", "--tenant", "alpha", "--limit", "1", "--require-split-proof"],
      cwd: "/repo",
      platform: "linux",
      nodeBinary: "node-test",
      env: {
        WRANGLER_BIN: "wrangler-test",
      },
      fileExists: () => false,
      execFileSync,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      }),
      now: () => new Date("2026-04-21T13:00:00.000Z"),
      stdout: writableStdout,
      stderr: writableStderr,
    });

    expect(exitCode).toBe(1);
    expect(output.stdout).toContain("### Split proof");
    expect(output.stdout).toContain("\"status\": \"missing_onchain_tx\"");
    expect(output.stderr).toContain("Split proof requirement failed with status 'missing_onchain_tx'.");
  });

  it("renders a markdown report ready for issue evidence", function assertMarkdownRendering() {
    const markdown = formatEvidenceMarkdown({
      issueNumber: 90,
      environment: "production",
      generatedAt: "2026-04-19T12:20:00.000Z",
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      orderId: "order_1",
      depositEntryId: "dep_1",
      workerUrl: "https://depix-mvp-production.dev865077.workers.dev",
      gitCommit: "abcdef123456",
      deploymentStatus: "Current Version ID: 123",
      migrationsStatus: "No migrations to apply!",
      health: {
        status: "ok",
      },
      opsReadiness: {
        depositRecheck: {
          state: "ready",
          ready: true,
        },
        depositsFallback: {
          state: "disabled",
          ready: false,
        },
      },
      splitProof: {
        status: "missing_onchain_tx",
        orderIds: ["order_1"],
        bankTxIds: ["fitbank_123"],
        blockchainTxIds: [],
        splitConfiguredOrders: 1,
        settledOrders: 1,
      },
      orders: [
        {
          order_id: "order_1",
          split_address: "lq1split",
          split_fee: "1.00%",
        },
      ],
      deposits: [
        {
          deposit_entry_id: "dep_1",
        },
      ],
      depositEvents: [
        {
          id: 1,
          deposit_entry_id: "dep_1",
          external_status: "paid",
        },
      ],
    });

    expect(markdown).toContain("## Evidencia controlada - issue #90");
    expect(markdown).toContain("`production`");
    expect(markdown).toContain("https://depix-mvp-production.dev865077.workers.dev");
    expect(markdown).toContain("order: `order_1`");
    expect(markdown).toContain("depositEntryId: `dep_1`");
    expect(markdown).toContain("### Ops readiness");
    expect(markdown).toContain("### Split proof");
    expect(markdown).toContain("\"status\": \"missing_onchain_tx\"");
    expect(markdown).toContain("\"order_id\": \"order_1\"");
    expect(markdown).toContain("\"deposit_entry_id\": \"dep_1\"");
    expect(markdown).toContain("### Deposit events correlacionados");
    expect(markdown).toContain("\"external_status\": \"paid\"");
    expect(markdown).not.toContain("raw_payload");
  });
});
