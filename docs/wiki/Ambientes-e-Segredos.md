# Ambientes e Segredos

## Ambientes declarados

Em `wrangler.jsonc`, o projeto define:

- `local`
- `test`
- `production`

## Secrets

O projeto depende de secrets por tenant para:

- token do bot Telegram
- secret do webhook Telegram
- token da Eulen
- secret do webhook Eulen

## Como o runtime resolve isso

O registro nao sensivel fica em `TENANT_REGISTRY`. Cada tenant aponta para nomes de bindings secretos, e o runtime materializa esses valores quando necessario.

Em `test` e `production`, o projeto usa `Cloudflare Secrets Store` via `secrets_store_secrets` no `wrangler.jsonc`.

Por isso, uma lista vazia de secrets classicos no Worker nao deve ser interpretada sozinha como ausencia de segredos no ambiente.

## Regra operacional

Secrets nao devem morar em codigo, `vars` versionadas ou arquivos reais commitados.

## Regra de leitura

Configuracao de ambiente e segredo por tenant sao parte da arquitetura, nao detalhe de deploy.
