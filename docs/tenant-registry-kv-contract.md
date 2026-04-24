# Tenant registry KV contract

This document is the provisioning, runtime read-path, and data-contract slice
for the tenant registry KV migration.

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

## Runtime source of truth

The Worker runtime reads `TENANT_REGISTRY_KV.get("TENANT_REGISTRY", "text")`
when materializing runtime configuration.

There is no fallback to the inline `TENANT_REGISTRY` var. If the KV binding or
key is absent, the Worker fails closed with the canonical
`invalid_tenant_registry` error.
