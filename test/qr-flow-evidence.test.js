import { describe, expect, it } from "vitest";

import {
  buildD1ExecuteArgs,
  buildDeploymentStatusArgs,
  buildHealthUrl,
  buildLatestDepositsQuery,
  buildLatestOrdersQuery,
  buildMigrationsListArgs,
  DEFAULT_OPERATION_TIMEOUT_MS,
  formatEvidenceMarkdown,
  parseD1ExecuteJsonOutput,
  readEvidenceCliOptions,
  resolveWranglerInvocation,
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
      "--issue",
      "90",
    ]);

    expect(options).toEqual({
      environment: "production",
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      limit: 3,
      issueNumber: 90,
    });
  });

  it("uses the canonical public health hosts for remote environments", function assertHealthUrlMapping() {
    expect(buildHealthUrl("test")).toBe("https://depix-mvp-test.dev865077.workers.dev/health");
    expect(buildHealthUrl("production")).toBe("https://depix-mvp-production.dev865077.workers.dev/health");
  });

  it("builds SQL filtered by tenant and timeframe", function assertQueryFilters() {
    const ordersQuery = buildLatestOrdersQuery({
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      limit: 2,
    });
    const depositsQuery = buildLatestDepositsQuery({
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      limit: 2,
    });

    expect(ordersQuery).toContain("o.channel = 'telegram'");
    expect(ordersQuery).toContain("o.tenant_id = 'beta'");
    expect(ordersQuery).toContain("julianday(o.updated_at) >= julianday('2026-04-19T02:00:00Z')");
    expect(ordersQuery).toContain("LIMIT 2;");
    expect(depositsQuery).toContain("INNER JOIN orders o ON o.order_id = d.order_id");
    expect(depositsQuery).toContain("d.tenant_id = 'beta'");
    expect(depositsQuery).toContain("julianday(d.updated_at) >= julianday('2026-04-19T02:00:00Z')");
    expect(depositsQuery).toContain("LIMIT 2;");
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

  it("renders a markdown report ready for issue evidence", function assertMarkdownRendering() {
    const markdown = formatEvidenceMarkdown({
      issueNumber: 90,
      environment: "production",
      generatedAt: "2026-04-19T12:20:00.000Z",
      tenantId: "beta",
      sinceIso: "2026-04-19T02:00:00Z",
      workerUrl: "https://depix-mvp-production.dev865077.workers.dev",
      gitCommit: "abcdef123456",
      deploymentStatus: "Current Version ID: 123",
      migrationsStatus: "No migrations to apply!",
      health: {
        status: "ok",
      },
      orders: [
        {
          order_id: "order_1",
        },
      ],
      deposits: [
        {
          deposit_entry_id: "dep_1",
        },
      ],
    });

    expect(markdown).toContain("## Evidencia controlada - issue #90");
    expect(markdown).toContain("`production`");
    expect(markdown).toContain("https://depix-mvp-production.dev865077.workers.dev");
    expect(markdown).toContain("\"order_id\": \"order_1\"");
    expect(markdown).toContain("\"deposit_entry_id\": \"dep_1\"");
  });
});
