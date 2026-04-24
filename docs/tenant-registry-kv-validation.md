# Tenant registry KV validation

Validation for #597, run after the runtime read-path migration in #729
(`7864b58`).

## Scope

This validation proves three things:

- tenant-routing and runtime-config checks pass with a KV-backed registry
- the Worker bundle for `local`, `test`, and `production` exposes
  `TENANT_REGISTRY_KV`
- the inline `TENANT_REGISTRY` var is absent from all Worker environments

## Runtime checks

Command:

```sh
npm test -- test/runtime-config.test.js test/tenant-routing.test.js
```

Result:

- `test/runtime-config.test.js`: 26 passed
- `test/tenant-routing.test.js`: 6 passed

Relevant coverage:

- `runtime-config` verifies `readRuntimeConfig` uses the KV registry even when
  an inline `TENANT_REGISTRY` value is present.
- `runtime-config` fails closed when `TENANT_REGISTRY_KV` is absent or when the
  `TENANT_REGISTRY` KV key is absent.
- `tenant-routing` seeds `TENANT_REGISTRY_KV` in the Cloudflare test runtime and
  resolves Telegram and Eulen tenant routes from that registry.

## Binding checks

Commands:

```sh
npx wrangler deploy --dry-run
npx wrangler deploy --env test --dry-run
npx wrangler deploy --env production --dry-run
```

Results captured from the `Your Worker has access to the following bindings`
section:

| Environment | KV binding emitted by dry-run | Inline `TENANT_REGISTRY` emitted by dry-run |
| --- | --- | --- |
| `local` | `env.TENANT_REGISTRY_KV (da9c68eed6a748a3b8cd181550fbd195)` | No |
| `test` | `env.TENANT_REGISTRY_KV (3e0405c5ed824272bb84b5beea298efa)` | No |
| `production` | `env.TENANT_REGISTRY_KV (66104d1784c84a3cad8eaaedcecd4caa)` | No |

The dry-run binding lists for all three environments include
`TENANT_REGISTRY_KV` and do not include an inline `TENANT_REGISTRY` environment
variable.

## Inline registry guard

The no-inline-registry assertion is covered by the dry-run binding evidence
above and by the contract test below. This avoids relying on ad hoc parsing of
`wrangler.jsonc`; the deploy dry-run output is the rendered Worker binding set.

## Contract check

Command:

```sh
npm test -- test/tenant-registry-kv-contract.test.ts
```

Result:

- `test/tenant-registry-kv-contract.test.ts`: 3 passed
