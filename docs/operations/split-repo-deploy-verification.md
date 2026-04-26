# Split Repository Deploy Verification

Issue: `#748`

This runbook verifies the separated repositories after the three-repository
cutover. It distinguishes Worker deploy targets from CI-only automation.

## Repository Matrix

| Repository | Runtime role | Verification command | Remote check |
| --- | --- | --- | --- |
| `dev865077/depix-mvp` | Product shell Worker | `npm test && npm run typecheck && npm run cf:types` | `GET /health` on the deployed Worker |
| `dev865077/DeBot` | Telegram bot Worker | `npm test` | `GET /health` on the deployed Worker |
| `dev865077/Sagui` | Financial API Worker | `npm test && npm run typecheck && npm run cf:types` | `GET /health` on the deployed Worker |
| `dev865077/AutoIA-Github` | GitHub automation repository | `npm test` | GitHub Actions `CI / Test` |

## Worker Health Probes

Use the deployed Worker URL for each environment:

```sh
curl -fsS "$DEPIX_MVP_BASE_URL/health"
curl -fsS "$DEBOT_BASE_URL/health"
curl -fsS "$SAGUI_BASE_URL/health"
```

`AutoIA-Github` does not deploy a Cloudflare Worker. Its deploy verification is
the repository CI plus successful workflow dispatch for the specific automation
being changed.

## Current Evidence

The latest hardening pass verified:

| Repository | Evidence |
| --- | --- |
| `depix-mvp` | PR `#753` merged after `Test`, `Analyze (actions)`, `Analyze (javascript-typescript)` and `CodeQL` passed; main CI and CodeQL also passed. |
| `DeBot` | PR `#3` merged after `Test` passed; main CI also passed. |
| `Sagui` | PR `#3` merged after `Test` passed; main CI also passed. |
| `AutoIA-Github` | PR `#2` merged after `Test` passed; main CI also passed. |

## Merge Gate

Branch protection is enabled on `main` for all four repositories:

| Repository | Required checks |
| --- | --- |
| `depix-mvp` | `Test`, `Analyze (actions)`, `Analyze (javascript-typescript)` |
| `DeBot` | `Test` |
| `Sagui` | `Test` |
| `AutoIA-Github` | `Test` |

All four repos have strict status checks enabled, enforce the rule for admins,
and disallow force pushes and branch deletion on `main`.

## Blockers

No code blocker remains for CI-based verification. Remote health probes require
the deployed Worker base URLs and Cloudflare credentials for each environment.
If those are unavailable, the blocker is operational access, not repository
code.
