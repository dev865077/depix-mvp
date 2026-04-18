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
- endereco DePix/Liquid de split
- percentual de split no formato da Eulen, como `1.00%`

## Como o runtime resolve isso

O registro nao sensivel fica em `TENANT_REGISTRY`. Cada tenant aponta para nomes de bindings secretos, e o runtime materializa esses valores quando necessario.

Em `test` e `production`, o projeto usa `Cloudflare Secrets Store` via `secrets_store_secrets` no `wrangler.jsonc`.

Por isso, uma lista vazia de secrets classicos no Worker nao deve ser interpretada sozinha como ausencia de segredos no ambiente.

Para split, o registry usa `splitConfigBindings`:

- `depixSplitAddress`
- `splitFee`

Os valores reais desses bindings ficam no Cloudflare Secrets Store em `test` e `production`, ou em `.dev.vars` no ambiente local.

## Regra operacional

Secrets e dados financeiros operacionais nao devem morar em codigo, `vars` versionadas ou arquivos reais commitados.

## Regra de leitura

Configuracao de ambiente e segredo por tenant sao parte da arquitetura, nao detalhe de deploy.
