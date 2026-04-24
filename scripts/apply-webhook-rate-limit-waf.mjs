import { readFileSync } from "node:fs";

const POLICY_PATH = "config/cloudflare/webhook-rate-limit-policy.json";
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

function readPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
}

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    dryRun: argv.includes("--dry-run"),
    disable: argv.includes("--disable"),
  };
}

function assertPolicy(policy) {
  const rule = policy.rule;

  if (!policy.rulesetName || typeof policy.rulesetName !== "string") {
    throw new Error("Missing policy.rulesetName.");
  }

  if (policy.phase !== "http_ratelimit") {
    throw new Error("Webhook rate limit policy must target http_ratelimit.");
  }

  if (!rule || typeof rule !== "object") {
    throw new Error("Missing policy.rule.");
  }

  if (rule.action !== "block") {
    throw new Error("Webhook rate limit rule must use block action.");
  }

  if (!rule.expression.includes("/telegram/") || !rule.expression.includes("/webhooks/eulen/")) {
    throw new Error("Webhook rate limit rule must cover Telegram and Eulen webhook paths.");
  }

  if (!Array.isArray(rule.ratelimit?.characteristics)
    || !rule.ratelimit.characteristics.includes("cf.colo.id")
    || !rule.ratelimit.characteristics.includes("ip.src")) {
    throw new Error("Webhook rate limit rule must count by Cloudflare colo and source IP.");
  }

  if (rule.ratelimit.period !== 60 || rule.ratelimit.requests_per_period !== 60) {
    throw new Error("Webhook rate limit rule must enforce 60 requests per 60 seconds.");
  }

  if (rule.ratelimit.mitigation_timeout !== 60) {
    throw new Error("Webhook rate limit rule must keep a 60-second mitigation timeout.");
  }
}

function buildRule(policy, options) {
  return {
    ...policy.rule,
    enabled: options.disable ? false : policy.rule.enabled !== false,
  };
}

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function cloudflareRequest(path, options = {}) {
  const token = getRequiredEnv("CLOUDFLARE_API_TOKEN");
  const response = await fetch(`${CLOUDFLARE_API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : {};

  if (response.status === 404) {
    return { status: response.status, body };
  }

  if (!response.ok || body.success === false) {
    const errors = Array.isArray(body.errors)
      ? body.errors.map((error) => error.message).join("; ")
      : bodyText;

    throw new Error(`Cloudflare API request failed (${response.status}): ${errors}`);
  }

  return { status: response.status, body };
}

async function readEntrypointRuleset(zoneId, phase) {
  const result = await cloudflareRequest(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);

  return result.status === 404 ? null : result.body.result;
}

async function createEntrypointRuleset(zoneId, policy, rule) {
  const result = await cloudflareRequest(`/zones/${zoneId}/rulesets`, {
    method: "POST",
    body: {
      name: policy.rulesetName,
      kind: "zone",
      phase: policy.phase,
      rules: [rule],
    },
  });

  return result.body.result;
}

async function updateEntrypointRuleset(zoneId, ruleset, policy, rule) {
  const existingRules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const rules = [
    ...existingRules.filter((existingRule) => existingRule.ref !== rule.ref),
    rule,
  ];
  const body = {
    name: ruleset.name || policy.rulesetName,
    kind: ruleset.kind || "zone",
    phase: policy.phase,
    rules,
  };

  if (ruleset.description) {
    body.description = ruleset.description;
  }

  const result = await cloudflareRequest(`/zones/${zoneId}/rulesets/${ruleset.id}`, {
    method: "PUT",
    body,
  });

  return result.body.result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = readPolicy();
  const rule = buildRule(policy, options);

  assertPolicy({ ...policy, rule });

  if (options.check) {
    console.log(`Policy OK: ${policy.policyName}`);
    return;
  }

  if (options.dryRun) {
    console.log(JSON.stringify({
      zoneId: process.env.CLOUDFLARE_ZONE_ID ?? "<required when applying>",
      phase: policy.phase,
      rulesetName: policy.rulesetName,
      rule,
    }, null, 2));
    return;
  }

  const zoneId = getRequiredEnv("CLOUDFLARE_ZONE_ID");
  const existingRuleset = await readEntrypointRuleset(zoneId, policy.phase);
  const ruleset = existingRuleset
    ? await updateEntrypointRuleset(zoneId, existingRuleset, policy, rule)
    : await createEntrypointRuleset(zoneId, policy, rule);

  console.log(JSON.stringify({
    policyName: policy.policyName,
    rulesetId: ruleset.id,
    phase: ruleset.phase,
    ruleRef: rule.ref,
    enabled: rule.enabled,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
