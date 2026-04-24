# Cloudflare webhook rate-limit policy

This runbook documents the primary webhook rate-limit control for #704.

## Primary control

Primary enforcement lives outside the Worker isolate in Cloudflare WAF custom
rate limiting rules.

- Cloudflare dashboard location: `Security` -> `WAF` -> `Rate limiting rules`
- Rulesets API phase: `http_ratelimit`
- Policy file: `config/cloudflare/webhook-rate-limit-policy.json`
- Apply script: `scripts/apply-webhook-rate-limit-waf.mjs`
- Policy name: `depix-mvp-public-webhook-rate-limit`

Cloudflare documents rate limiting rules as Ruleset Engine rules deployed to
the zone `http_ratelimit` phase:

- https://developers.cloudflare.com/waf/rate-limiting-rules/
- https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/
- https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/

The webhook hostname must be served through a Cloudflare zone controlled by the
project account. If a public webhook is still configured directly on a
`workers.dev` hostname, move that route to the managed zone/custom domain
before treating WAF rate limiting as the primary protection for that host.

## Covered routes

The same WAF rule applies to:

- `POST /telegram/:tenantId/webhook`
- `POST /webhooks/eulen/:tenantId/deposit`

The rule expression is:

```text
(http.request.method eq "POST" and (http.request.uri.path matches "^/telegram/[^/]+/webhook$" or http.request.uri.path matches "^/webhooks/eulen/[^/]+/deposit$"))
```

## Policy

The initial policy is intentionally IP-based because the public webhook callers
are unauthenticated at the Cloudflare edge and because IP counting is available
across Cloudflare plans that support rate limiting rules.

- action: `block`
- characteristics: `cf.colo.id`, `ip.src`
- period: `60`
- requests per period: `60`
- mitigation timeout: `60`

Cloudflare's rate limiting block action is expected to produce `429` responses
with `Retry-After`. Do not add a custom response body unless the operator has
verified that `Retry-After` behavior remains intact.

## Apply or update

Validate the versioned policy:

```sh
npm run waf:webhook-rate-limit:check
```

Preview the payload:

```sh
npm run waf:webhook-rate-limit:dry-run
```

Apply to the target Cloudflare zone:

```sh
CLOUDFLARE_ZONE_ID="<zone-id>" \
CLOUDFLARE_API_TOKEN="<api-token-with-rulesets-edit>" \
npm run waf:webhook-rate-limit:apply
```

The script is idempotent by rule `ref`:
`depix_mvp_public_webhook_rate_limit`. If the zone entrypoint ruleset already
exists, the script replaces the existing rule with the same ref and keeps the
rule at the end of the `http_ratelimit` rules list, as required by the
Cloudflare rate limiting API.

## Review or adjust

Review in either place:

- Cloudflare dashboard: `Security` -> `WAF` -> `Rate limiting rules`
- Rulesets API: zone entrypoint ruleset for phase `http_ratelimit`

To adjust the limit, edit `config/cloudflare/webhook-rate-limit-policy.json`,
run the policy check, open a PR, and apply the merged policy with the script.
Do not hand-edit a different dashboard rule shape without porting the same
change back to the versioned policy file.

## Local fallback

The Worker still contains the previous fixed-window in-memory limiter as an
explicit fallback only. It is disabled by default in `wrangler.jsonc`.

Fallback flag:

```text
ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK=true
```

Use this only when the Cloudflare WAF policy is unavailable or temporarily
disabled during rollout. It is per-isolate memory and must not be treated as the
primary public protection.

## Rollback

Preferred rollback: disable or delete the WAF rate limiting rule in
Cloudflare's `http_ratelimit` phase.

If protection must remain active while the WAF rule is disabled, temporarily set
`ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK=true` and redeploy the affected
Worker environment. Revert that flag once the Cloudflare policy is corrected.

## Validation checklist

- `npm run waf:webhook-rate-limit:check`
- `npm test -- test/cloudflare-webhook-rate-limit-policy.test.js test/webhook-rate-limit.test.ts`
- Cloudflare dashboard shows policy
  `depix-mvp-public-webhook-rate-limit` enabled in WAF rate limiting rules.
- Equivalent webhook requests through the public test host receive the same
  `429` and `Retry-After` outcome when the WAF threshold is exceeded, even when
  Worker isolate-local state is cold or different.
