# Testes e Qualidade

## Como a suite e organizada

- testes de unidade
- testes de integracao de Worker
- testes de contrato de rotas
- testes de regressao operacional
- specs Node e Cloudflare separados pelo runner sequencial

## Comandos principais

- `npm test`
- `npm run typecheck`
- `npm run cf:types`
- `npm run dev`

## Suite atual no repositorio

- `test/bootstrap-boundary.test.js`
- `test/db-repositories-contract.test.js`
- `test/db-repositories-runtime-import.test.js`
- `test/db.repositories.test.js`
- `test/deposit-recheck.test.js`
- `test/eulen-client.test.js`
- `test/eulen-webhook.test.js`
- `test/health.test.js`
- `test/ops-diagnostics.test.js`
- `test/ops-telegram-webhook.test.js`
- `test/order-progress-machine-runtime-import.test.js`
- `test/order-progress-machine.test.js`
- `test/order-registration.test.js`
- `test/qr-flow-evidence.test.js`
- `test/runtime-config.test.js`
- `test/scripts/cloudflare-pool-markers.test.js`
- `test/scripts/run-vitest-sequential.test.ts`
- `test/telegram-brl-amount.test.js`
- `test/telegram-payment-notifications.test.js`
- `test/telegram-raw-update.test.js`
- `test/telegram-runtime.test.js`
- `test/telegram-wallet-address.test.js`
- `test/telegram-webhook-reply.test.js`
- `test/tenant-routing.test.js`
- `test/typescript-runtime-cleanup.test.js`

Os testes de automacao GitHub foram movidos para
`dev865077/AutoIA-Github/test/`.

## Estado atual do CI

O workflow `CI` roda automaticamente em:

- `pull_request`
- `push` para `main`
- execucao manual por `workflow_dispatch`

O contrato do CI e `npm ci` seguido de `npm test`, com `CI=true`.

## Ambiente de teste

A suite do GitHub Actions usa o mesmo contrato local do Vitest:

- `vitest.config.js` mantem o pool `cloudflarePool`
- `vitest.node.config.js` isola specs Node
- `vitest.config.js` fornece bindings fake versionados para o runner
- `wrangler.jsonc` continua sendo a fonte da configuracao do Worker
- `APP_ENV=local` identifica o harness local do Worker
- `DB` usa D1 local do pool Cloudflare
- tokens, webhook secrets e split config usados no CI sao valores fake e deterministicos

Os ambientes remotos `test` e `production` continuam usando
`secrets_store_secrets` e nao sao consumidos pela suite automatizada do GitHub.

## Regra de manutencao

Mudancas que alterem comportamento, contrato de rota, bootstrap ou operacao
precisam vir acompanhadas de teste ou de validacao equivalente.

## Migracao TypeScript

A matriz operacional da migracao TypeScript fica em
[Validacao e Rollback TypeScript](Validacao-e-Rollback-TypeScript).
O fechamento documental da epic fica em [Migracao TypeScript](Migracao-TypeScript).

Para ondas sensiveis, `npm test` sozinho nao e evidencia suficiente. A PR deve
listar tambem os comandos focados, smokes HTTP ou dry-runs exigidos para a
superficie alterada.

Specs Cloudflare precisam declarar o marcador explicito:

```js
// @vitest-pool cloudflare
```

Esse marcador e a fonte de verdade do runner sequencial para escolher entre
`vitest.config.js` e `vitest.node.config.js`.
