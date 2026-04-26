import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const POLICY_PATH = "config/cloudflare/webhook-rate-limit-policy.json";

function readPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
}

describe("Cloudflare webhook rate limit policy", () => {
  it("defines one WAF custom rate limit rule for both public webhook routes", () => {
    const policy = readPolicy();
    const rule = policy.rule;

    expect(policy.phase).toBe("http_ratelimit");
    expect(policy.policyName).toBe("depix-mvp-public-webhook-rate-limit");
    expect(rule.action).toBe("block");
    expect(rule.enabled).toBe(true);
    expect(rule.expression).toContain("http.request.method eq \"POST\"");
    expect(rule.expression).toContain("^/telegram/[^/]+/webhook$");
    expect(rule.expression).toContain("^/webhooks/eulen/[^/]+/deposit$");
    expect(rule.ratelimit).toEqual({
      characteristics: [
        "cf.colo.id",
        "ip.src",
      ],
      period: 60,
      requests_per_period: 60,
      mitigation_timeout: 60,
    });
  });

  it("validates the policy through the operational script", () => {
    const output = execFileSync("node", [
      "scripts/apply-webhook-rate-limit-waf.mjs",
      "--check",
    ], {
      encoding: "utf8",
    });

    expect(output).toContain("Policy OK: depix-mvp-public-webhook-rate-limit");
  });
});
