# Cloudflare Secrets Store - Runbook

Este documento registra o contrato operacional atual do `Cloudflare Secrets Store` no `depix-mvp`.

Para a matriz consolidada por `debot`, `api` e `github-automation`, use
[`docs/operations/secrets-and-environment-inventory.md`](./operations/secrets-and-environment-inventory.md).
Este runbook permanece como detalhe especifico do Secrets Store usado pelo
monolito de transicao e pela futura superficie `api`.

## Estado atual

- `test` usa `Cloudflare Secrets Store`
- `production` usa `Cloudflare Secrets Store`
- `local` continua usando `.dev.vars`

Store atual:

- `default_secrets_store`
- `store_id`: `741675cd40cf4ce4885faf1c0e9ccc5b`

## Bindings versionados em test e production

O `wrangler.jsonc` de `test` e `production` usa estes bindings:

- `ALPHA_TELEGRAM_BOT_TOKEN`
- `ALPHA_TELEGRAM_WEBHOOK_SECRET`
- `ALPHA_EULEN_API_TOKEN`
- `ALPHA_EULEN_WEBHOOK_SECRET`
- `ALPHA_DEPIX_SPLIT_ADDRESS`
- `ALPHA_DEPIX_SPLIT_FEE`
- `BETA_TELEGRAM_BOT_TOKEN`
- `BETA_TELEGRAM_WEBHOOK_SECRET`
- `BETA_EULEN_API_TOKEN`
- `BETA_EULEN_WEBHOOK_SECRET`
- `BETA_DEPIX_SPLIT_ADDRESS`
- `BETA_DEPIX_SPLIT_FEE`

## Secret names atuais de production

- `production-alpha-telegram-bot-token`
- `production-alpha-telegram-webhook-secret`
- `production-alpha-eulen-api-token`
- `production-alpha-eulen-webhook-secret`
- `production-alpha-depix-split-address`
- `production-alpha-depix-split-fee`
- `production-beta-telegram-bot-token`
- `production-beta-telegram-webhook-secret`
- `production-beta-eulen-api-token`
- `production-beta-eulen-webhook-secret`
- `production-beta-depix-split-address`
- `production-beta-depix-split-fee`

## Secret names atuais de test

- `test-alpha-telegram-bot-token`
- `test-alpha-telegram-webhook-secret`
- `test-alpha-eulen-api-token`
- `test-alpha-eulen-webhook-secret`
- `test-alpha-depix-split-address`
- `test-alpha-depix-split-fee`
- `test-beta-telegram-bot-token`
- `test-beta-telegram-webhook-secret`
- `test-beta-eulen-api-token`
- `test-beta-eulen-webhook-secret`
- `test-beta-depix-split-address`
- `test-beta-depix-split-fee`

## Split DePix

O split da cobranca e obrigatorio no MVP. O registry em `TENANT_REGISTRY_KV`
guarda apenas nomes de bindings em `splitConfigBindings`.

Valores reais ficam no `Secrets Store`:

- `*-depix-split-address`: endereco de recebimento DePix/Liquid. SideSwap gera enderecos confidenciais com prefixo `lq1`, que sao aceitos pelo runtime; exemplos da Eulen tambem podem aparecer como `ex1`.
- `*-depix-split-fee`: percentual do split no formato documentado pela Eulen, por exemplo `1.00%`

Esses valores sao tratados como confidenciais operacionais. Eles nao dao gasto direto de fundos, mas revelam destino financeiro e condicao comercial.

## O que nao vai para o store

Continuam como configuracao versionada:

- `APP_NAME`
- `APP_ENV`
- `LOG_LEVEL`
- `EULEN_API_BASE_URL`
- `EULEN_API_TIMEOUT_MS`
- `displayName`
- `eulenPartnerId`
- `splitConfigBindings`

O registry de tenants deixa de ficar em `vars`; o Worker le a chave
`TENANT_REGISTRY` no binding KV `TENANT_REGISTRY_KV`.

## Rotacao de um secret de test ou production

1. Atualizar o valor do secret no `Secrets Store`
2. Manter o mesmo `secret_name` quando a rotacao nao exigir rename
3. Publicar o ambiente correspondente novamente para validar os bindings do Worker
4. Validar `GET /health` e o fluxo operacional afetado

Comando de validacao segura:

```bash
npx wrangler deploy --env test --dry-run
npx wrangler deploy --env production --dry-run
```
