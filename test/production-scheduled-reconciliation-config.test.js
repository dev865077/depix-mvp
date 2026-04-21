/**
 * Regressao de configuracao production para a reconciliação agendada.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readWranglerConfig() {
  const rawConfig = readFileSync("wrangler.jsonc", "utf8");
  const withoutLineComments = rawConfig
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  return JSON.parse(withoutLineComments);
}

describe("production scheduled deposit reconciliation config", () => {
  it("keeps the production cron and kill switch enabled together", function assertProductionSchedulerEnabled() {
    const config = readWranglerConfig();
    const production = config.env.production;

    expect(production.triggers.crons).toContain("*/15 * * * *");
    expect(production.vars.ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION).toBe("true");
  });
});
