# Secrets and environment inventory

This page is the shared operational SSOT for variables, bindings, and secrets
while `depix-mvp` is being split into `debot`, `api`, and
`github-automation`.

Until the cutover from track `#674` is complete, the concrete values still live
in the current `depix-mvp` Cloudflare Worker and GitHub repository settings.
After cutover, each row below identifies the target repository that owns the
credential or variable.

## Repository ownership

| Repository | Operational scope | Secret owner |
| --- | --- | --- |
| `debot` | Telegram runtime, bot webhooks, conversation state, bot -> API calls | Bot operator |
| `api` | Eulen integration, financial D1, payment webhooks, ops financial routes, WAF policy | Financial/API operator |
| `github-automation` | Issue triage, planning, refinement, PR review, wiki publication | Repository automation maintainer |

## Environments

| Environment | Current source | Target repository use |
| --- | --- | --- |
| `local` | `.dev.vars`, local D1/KV bindings, local GitHub shell env when needed | Per-repository local setup |
| `test` | Cloudflare Secrets Store and GitHub Actions repository settings | Published test Workers and automation workflows |
| `production` | Cloudflare Secrets Store and GitHub Actions repository settings | Published production Workers and automation workflows |

## `debot`

| Name | Kind | Purpose | Source/provisioning | Environments | Rotation/update owner |
| --- | --- | --- | --- | --- | --- |
| `APP_NAME` | Worker var | Worker/application identity | Versioned Worker config | `local`, `test`, `production` | Bot operator |
| `APP_ENV` | Worker var | Runtime environment discriminator | Versioned Worker config | `local`, `test`, `production` | Bot operator |
| `LOG_LEVEL` | Worker var | Runtime log verbosity | Versioned Worker config | `local`, `test`, `production` | Bot operator |
| `TENANT_REGISTRY_KV` | KV binding | Tenant registry lookup for bot routing and secret binding names | Cloudflare KV namespace binding | `local`, `test`, `production` | Bot operator |
| `TENANT_REGISTRY` | KV key | Non-secret tenant registry payload | Seeded through `config/tenant-registry.seed.json` and KV tooling | `local`, `test`, `production` | Bot operator |
| `ALPHA_TELEGRAM_BOT_TOKEN` | Secret binding | Alpha Telegram bot API token | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | Bot operator |
| `ALPHA_TELEGRAM_WEBHOOK_SECRET` | Secret binding | Alpha Telegram webhook verification secret | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | Bot operator |
| `BETA_TELEGRAM_BOT_TOKEN` | Secret binding | Beta Telegram bot API token | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | Bot operator |
| `BETA_TELEGRAM_WEBHOOK_SECRET` | Secret binding | Beta Telegram webhook verification secret | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | Bot operator |
| `FINANCIAL_API_BASE_URL` | Worker var | Base URL for bot -> Sagui financial API calls | Versioned Worker config | `local`, `test`, `production` | Bot operator and API operator |
| `DEBOT_INTERNAL_API_TOKEN` | Secret | Target service token for `debot` -> `api` calls after split | New secret in `debot` and accepted by `api` | `test`, `production` after cutover | Bot operator and API operator |

## `api`

| Name | Kind | Purpose | Source/provisioning | Environments | Rotation/update owner |
| --- | --- | --- | --- | --- | --- |
| `APP_NAME` | Worker var | Worker/application identity | Versioned Worker config | `local`, `test`, `production` | API operator |
| `APP_ENV` | Worker var | Runtime environment discriminator | Versioned Worker config | `local`, `test`, `production` | API operator |
| `LOG_LEVEL` | Worker var | Runtime log verbosity | Versioned Worker config | `local`, `test`, `production` | API operator |
| `DB` | D1 binding | Financial persistence for orders, deposits, and deposit events | Cloudflare D1 binding | `local`, `test`, `production` | API operator |
| `TENANT_REGISTRY_KV` | KV binding | Tenant registry lookup for financial binding names and partner IDs | Cloudflare KV namespace binding | `local`, `test`, `production` | API operator |
| `EULEN_API_BASE_URL` | Worker var | Eulen API base URL | Versioned Worker config | `local`, `test`, `production` | API operator |
| `EULEN_API_TIMEOUT_MS` | Worker var | Timeout for Eulen HTTP calls | Versioned Worker config | `local`, `test`, `production` | API operator |
| `ALPHA_EULEN_API_TOKEN` | Secret binding | Alpha Eulen API bearer token | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `ALPHA_EULEN_WEBHOOK_SECRET` | Secret binding | Alpha Eulen webhook verification secret | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `ALPHA_DEPIX_SPLIT_ADDRESS` | Secret binding | Alpha DePix/Liquid split address | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `ALPHA_DEPIX_SPLIT_FEE` | Secret binding | Alpha split fee value in Eulen format | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `BETA_EULEN_API_TOKEN` | Secret binding | Beta Eulen API bearer token | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `BETA_EULEN_WEBHOOK_SECRET` | Secret binding | Beta Eulen webhook verification secret | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `BETA_DEPIX_SPLIT_ADDRESS` | Secret binding | Beta DePix/Liquid split address | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `BETA_DEPIX_SPLIT_FEE` | Secret binding | Beta split fee value in Eulen format | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `OPS_ROUTE_BEARER_TOKEN` | Secret binding | Bearer token for manual operational financial routes | `.dev.vars` locally; Cloudflare Secrets Store in published envs | `local`, `test`, `production` | API operator |
| `ENABLE_OPS_DEPOSIT_RECHECK` | Worker var | Enables manual deposit recheck route | Versioned Worker config | `test`, `production` | API operator |
| `ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK` | Worker var | Explicit local fallback for webhook rate limiting when WAF policy is unavailable | Versioned Worker config | `local`, `test`, `production` | API operator |
| `CLOUDFLARE_ZONE_ID` | Operator env | Target zone for applying WAF webhook rate limit | Operator shell/CI secret for WAF apply script | `test`, `production` operations | API operator |
| `CLOUDFLARE_API_TOKEN` | Operator secret | Token with Rulesets edit permission for WAF apply script | Operator shell/CI secret, not versioned | `test`, `production` operations | API operator |

## `github-automation`

| Name | Kind | Purpose | Source/provisioning | Environments | Rotation/update owner |
| --- | --- | --- | --- | --- | --- |
| `GITHUB_TOKEN` | GitHub Actions token | GitHub API access inside workflows | GitHub Actions runtime injection | GitHub Actions | Repository automation maintainer |
| `OPENAI_API_KEY` | GitHub secret | Model API access for issue triage, planning, refinement, PR review, and wiki update | GitHub repository secret | GitHub Actions | Repository automation maintainer |
| `OPENAI_ISSUE_TRIAGE_MODEL` | GitHub variable | Model for issue triage | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `OPENAI_ISSUE_PLANNING_REVIEW_MODEL` | GitHub variable | Model for planning review | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `OPENAI_ISSUE_REFINEMENT_MODEL` | GitHub variable | Model for issue refinement | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `OPENAI_PR_CLASSIFY_MODEL` | GitHub variable | Model for PR lane classification | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `OPENAI_PR_REVIEW_MODEL` | GitHub variable | Model for direct and Discussion PR review | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `OPENAI_WIKI_UPDATE_MODEL` | GitHub variable | Model for wiki update after merge | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `AI_ISSUE_PLANNING_DISCUSSION_CATEGORY` | GitHub variable | Preferred GitHub Discussion category for issue planning | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `AI_ISSUE_TRIAGE_DISCUSSION_CATEGORY` | GitHub variable | Temporary fallback category for planning Discussion creation | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `AI_PR_DISCUSSION_CATEGORY` | GitHub variable | Preferred GitHub Discussion category for PR review lane | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `AI_ISSUE_REFINEMENT_PROVIDER` | GitHub variable | Provider selector for issue refinement | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `AI_ISSUE_REFINEMENT_ENDPOINT` | GitHub variable | Optional custom refinement endpoint | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `AI_ISSUE_REFINEMENT_BEARER_TOKEN` | GitHub secret | Optional bearer token for custom refinement endpoint | GitHub repository secret | GitHub Actions | Repository automation maintainer |
| `AI_ISSUE_REFINEMENT_MAX_ROUNDS` | GitHub variable | Maximum refinement loop count | GitHub repository variable | GitHub Actions | Repository automation maintainer |
| `WIKI_PUSH_TOKEN` | GitHub secret | Optional token for publishing the generated GitHub Wiki repository | GitHub repository secret | GitHub Actions | Repository automation maintainer |

## Versioned non-secrets

These values may remain versioned because they are configuration, not secrets:

- Worker entrypoint and compatibility settings in `wrangler.jsonc`.
- `APP_NAME`, `APP_ENV`, `LOG_LEVEL`, `EULEN_API_BASE_URL`, and `EULEN_API_TIMEOUT_MS`.
- Tenant display names, Eulen partner IDs, and binding names in the tenant registry.
- Prompt paths and workflow mode names in `.github/workflows/*.yml`.

## Rotation notes

- Telegram bot tokens and webhook secrets rotate in `debot`.
- Eulen API tokens, Eulen webhook secrets, split addresses, split fees, ops tokens, and WAF operator credentials rotate in `api`.
- OpenAI and wiki publication credentials rotate in `github-automation`.
- When a secret name is reused, update the provider-side value and redeploy or rerun the affected workflow.
- When a secret binding name changes, update the registry or workflow variable in the same PR as the operational doc change.
