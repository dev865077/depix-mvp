# Tenant registry onboarding and update runbook

This is the operator runbook for adding or updating tenants after the registry
move to Cloudflare KV.

## Source of truth

- Runtime source of truth: KV binding `TENANT_REGISTRY_KV`, key
  `TENANT_REGISTRY`.
- Versioned registry payload: `config/tenant-registry.seed.json`.
- Do not add tenant JSON to `wrangler.jsonc`.
- Do not put secret values, split addresses, split fees, API tokens, or webhook
  secrets in the registry. The registry stores binding names only.

`wrangler.jsonc` still owns Worker infrastructure bindings such as D1, KV
namespaces, feature flags, and already declared Secrets Store bindings. Tenant
registry changes must not reintroduce inline `TENANT_REGISTRY` vars there.

## Preconditions

Before seeding a new or changed tenant, every binding name referenced by the
tenant record must exist in the target Worker environment.

For the current registry shape, each tenant needs:

- `secretBindings.telegramBotToken`
- `secretBindings.telegramWebhookSecret`
- `secretBindings.eulenApiToken`
- `secretBindings.eulenWebhookSecret`
- `splitConfigBindings.depixSplitAddress`
- `splitConfigBindings.splitFee`

Optional tenant-scoped operations auth uses:

- `opsBindings.depositRecheckBearerToken`

If a new tenant introduces binding names that do not exist yet, provision those
bindings first. That is a secrets/binding provisioning task, not a registry
payload task.

## Tenant record shape

Add or update one top-level key per tenant id:

```json
{
  "alpha": {
    "displayName": "Alpha",
    "eulenPartnerId": "partner-alpha",
    "splitConfigBindings": {
      "depixSplitAddress": "ALPHA_DEPIX_SPLIT_ADDRESS",
      "splitFee": "ALPHA_DEPIX_SPLIT_FEE"
    },
    "secretBindings": {
      "telegramBotToken": "ALPHA_TELEGRAM_BOT_TOKEN",
      "telegramWebhookSecret": "ALPHA_TELEGRAM_WEBHOOK_SECRET",
      "eulenApiToken": "ALPHA_EULEN_API_TOKEN",
      "eulenWebhookSecret": "ALPHA_EULEN_WEBHOOK_SECRET"
    }
  }
}
```

Rules:

- keep `tenantId` stable once orders or deposits exist for that tenant
- omit `displayName` only when the tenant id is acceptable as the display name
- use `eulenPartnerId` only when the upstream partner id is known
- keep binding names explicit; do not derive them in code or documentation
- declare `opsBindings.depositRecheckBearerToken` only when that tenant should
  stop using the global `OPS_ROUTE_BEARER_TOKEN` fallback

## Add a tenant

1. Edit `config/tenant-registry.seed.json`.
2. Add the new tenant object under the chosen tenant id.
3. Confirm every binding name in the new object exists in each target
   environment.
4. Run the contract and runtime checks:

   ```sh
   npm test -- test/tenant-registry-kv-contract.test.ts test/runtime-config.test.js test/tenant-routing.test.js
   ```

5. Review the Worker binding set without deploying:

   ```sh
   npx wrangler deploy --dry-run
   npx wrangler deploy --env test --dry-run
   npx wrangler deploy --env production --dry-run
   ```

   Expected result: each dry-run lists `env.TENANT_REGISTRY_KV` and does not
   list an inline `env.TENANT_REGISTRY` environment variable.

6. After review, seed the KV registry:

   ```sh
   npm run kv:tenant-registry:seed
   ```

   This writes `config/tenant-registry.seed.json` to key `TENANT_REGISTRY` in
   the `local`, `test`, and `production` KV namespaces configured in
   `wrangler.jsonc`.

7. Validate `/health` in the target environment. The tenant should appear in
   the redacted tenant inventory without exposing raw binding maps or secret
   values.

## Update a tenant

1. Edit only the tenant object in `config/tenant-registry.seed.json`.
2. Keep the tenant id unchanged.
3. If changing binding names, provision the new bindings before seeding KV.
4. Run the same checks and dry-runs from the add flow.
5. Seed KV with `npm run kv:tenant-registry:seed`.
6. Validate the changed route or `/health` in the target environment.

## Roll back a registry change

1. Restore the previous `config/tenant-registry.seed.json` payload from git.
2. Run:

   ```sh
   npm test -- test/tenant-registry-kv-contract.test.ts test/runtime-config.test.js test/tenant-routing.test.js
   npm run kv:tenant-registry:seed
   ```

3. Validate `/health` again.

Rolling back the registry does not delete secrets or D1 data. If the failed
change also provisioned new secrets or external webhooks, handle those as a
separate operational cleanup.

## Review checklist

- `config/tenant-registry.seed.json` is the only registry payload file changed
- `wrangler.jsonc` does not add or reintroduce inline `TENANT_REGISTRY`
- every binding name in the tenant record exists in each target environment
- contract and routing checks pass
- dry-run output lists `TENANT_REGISTRY_KV` for `local`, `test`, and
  `production`
- `/health` shows the expected redacted tenant inventory after seeding
