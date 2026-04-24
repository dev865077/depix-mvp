# Tenant registry KV contract

This document is the provisioning and data-contract slice for #594.

## Binding

Each Worker environment binds the tenant registry namespace as `TENANT_REGISTRY_KV`.

| Environment | KV namespace title | Binding |
| --- | --- | --- |
| `local` | `depix-mvp-tenant-registry-local` | `TENANT_REGISTRY_KV` |
| `test` | `test-depix-mvp-tenant-registry-test` | `TENANT_REGISTRY_KV` |
| `production` | `production-depix-mvp-tenant-registry-production` | `TENANT_REGISTRY_KV` |

## Key and value

- KV key: `TENANT_REGISTRY`
- Value type: JSON object
- Shape: `{ "<tenant-id>": <tenant-record>, ... }`

The seed payload is versioned in `config/tenant-registry.seed.json`.
The same payload must be written to `local`, `test`, and `production`.

## Transitional rule

The current Worker read path still reads the inline `TENANT_REGISTRY` var until
the follow-up read-path migration issue switches runtime reads to KV. During
that transition, `config/tenant-registry.seed.json` is the canonical seed
source and the inline var is only a compatibility mirror.
