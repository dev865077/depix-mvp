# Ambientes e Segredos

## Objetivo

Documentar como o projeto separa ambientes e como os secrets entram no runtime.

## Ambientes declarados no repo

Em `wrangler.jsonc`, o projeto define:

- `local`
- `test`
- `production`

Cada ambiente varia principalmente em:

- `APP_ENV`
- `LOG_LEVEL`
- banco `D1`
- bindings de configuracao

## Secrets

Secrets nao devem morar em codigo, `vars` versionadas ou `.dev.vars` real no repositorio.

O projeto depende de secrets por tenant para:

- token do bot Telegram
- secret do webhook Telegram
- token da Eulen
- secret do webhook Eulen

## Como o runtime resolve secrets

O registro nao sensivel fica em `TENANT_REGISTRY`. Cada tenant aponta para nomes de bindings secretos, e `src/config/tenants.js` materializa esses valores quando preciso.

## Tenants de exemplo

O repo usa `alpha` e `beta` como tenants ficticios de configuracao. Eles existem para estruturar o multi-tenant sem expor parceiros reais.

## Arquivos relevantes

- `wrangler.jsonc`
- `.dev.vars.example`
- `src/config/tenants.js`

## Regra operacional

Qualquer mudanca em formato de tenant, secrets ou ambiente precisa atualizar esta documentacao na mesma PR.
