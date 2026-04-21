# Testes e Qualidade

## Stack definida

- `Vitest`
- `@cloudflare/vitest-pool-workers`
- runtime real de `Cloudflare Workers` durante a suite

## Suite atual no repositorio

- `test/ai-pr-review.test.js`
- `test/ai-wiki-update.test.js`
- `test/health.test.js`
- `test/tenant-routing.test.js`
- `test/telegram-runtime.test.js`
- `test/telegram-webhook-reply.test.js`
- `test/eulen-client.test.js`
- `test/eulen-webhook.test.js`
- `test/ops-diagnostics.test.js`
- `test/db.repositories.test.js`

## Estado atual do CI

O workflow `CI` roda automaticamente em:

- `pull_request`
- `push` para `main`
- execucao manual por `workflow_dispatch`

O contrato do CI e `npm ci` seguido de `npm test`, com `CI=true`.

## Ambiente de teste

A suite do GitHub Actions usa o mesmo contrato local do Vitest:

- `vitest.config.js` mantem o pool `cloudflarePool`
- `vitest.config.js` fornece bindings fake versionados para o runner
- `wrangler.jsonc` continua sendo a fonte da configuracao do Worker
- `APP_ENV=local` identifica o harness local do Worker
- `DB` usa D1 local do pool Cloudflare
- tokens, webhook secrets e split config usados no CI sao valores fake e deterministicos

Os ambientes remotos `test` e `production` continuam usando `secrets_store_secrets` e nao sao consumidos pela suite automatizada do GitHub.

## Leitura correta

PR verde precisa considerar o check `CI / Test` junto com CodeQL e a review automatizada.

O CI valida comportamento automatizado do repositorio sem depender de segredo real, `.dev.vars` local ou Secrets Store remoto.

## Migracao TypeScript

A matriz operacional da migracao TypeScript fica em [Validacao e Rollback TypeScript](Validacao-e-Rollback-TypeScript).

Para ondas sensiveis, `npm test` sozinho nao e evidencia suficiente. A PR deve
listar tambem os comandos focados, smokes HTTP ou dry-runs exigidos para a
superficie alterada.
