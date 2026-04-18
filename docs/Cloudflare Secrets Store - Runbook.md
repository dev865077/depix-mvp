# Cloudflare Secrets Store - Runbook

Este documento registra o contrato operacional atual do `Cloudflare Secrets Store` no `depix-mvp`.

## Estado atual

- `production` usa `Cloudflare Secrets Store`
- `local` continua usando `.dev.vars`
- `test` ainda nao esta bindado ao store no `main`

Store atual:

- `default_secrets_store`
- `store_id`: `741675cd40cf4ce4885faf1c0e9ccc5b`

## Bindings versionados em production

O `wrangler.jsonc` de `production` usa estes bindings:

- `ALPHA_TELEGRAM_BOT_TOKEN`
- `ALPHA_TELEGRAM_WEBHOOK_SECRET`
- `ALPHA_EULEN_API_TOKEN`
- `ALPHA_EULEN_WEBHOOK_SECRET`
- `BETA_TELEGRAM_BOT_TOKEN`
- `BETA_TELEGRAM_WEBHOOK_SECRET`
- `BETA_EULEN_API_TOKEN`
- `BETA_EULEN_WEBHOOK_SECRET`

## Secret names atuais de production

- `production-alpha-telegram-bot-token`
- `production-alpha-telegram-webhook-secret`
- `production-alpha-eulen-api-token`
- `production-alpha-eulen-webhook-secret`
- `production-beta-telegram-bot-token`
- `production-beta-telegram-webhook-secret`
- `production-beta-eulen-api-token`
- `production-beta-eulen-webhook-secret`

## O que nao vai para o store

Continuam como configuracao versionada:

- `APP_NAME`
- `APP_ENV`
- `LOG_LEVEL`
- `EULEN_API_BASE_URL`
- `EULEN_API_TIMEOUT_MS`
- `TENANT_REGISTRY`
- `displayName`
- `eulenPartnerId`
- `splitConfig`

## Rotacao de um secret de production

1. Atualizar o valor do secret no `Secrets Store`
2. Manter o mesmo `secret_name` quando a rotacao nao exigir rename
3. Publicar `production` novamente para validar os bindings do Worker
4. Validar `GET /health` e o fluxo operacional afetado

Comando de validacao segura:

```bash
npx wrangler deploy --env production --dry-run
```

## Proxima etapa para test

Antes de bindar `test` no repo, o store precisa ter os 8 secrets `test-*`:

- `test-alpha-telegram-bot-token`
- `test-alpha-telegram-webhook-secret`
- `test-alpha-eulen-api-token`
- `test-alpha-eulen-webhook-secret`
- `test-beta-telegram-bot-token`
- `test-beta-telegram-webhook-secret`
- `test-beta-eulen-api-token`
- `test-beta-eulen-webhook-secret`

So depois disso vale abrir a PR que leva `secrets_store_secrets` tambem para `test`.
