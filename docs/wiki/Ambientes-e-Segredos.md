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

Tambem existe um segredo operacional transversal:

- `OPS_ROUTE_BEARER_TOKEN` para autenticar chamadas manuais no namespace `/ops`

Tambem existe uma flag operacional explicita:

- `ENABLE_OPS_DEPOSIT_RECHECK=true` para habilitar de fato `POST /ops/:tenantId/recheck/deposit`

## Como o runtime resolve isso

O registro nao sensivel fica em `TENANT_REGISTRY`. Cada tenant aponta para nomes de bindings secretos, e o runtime materializa esses valores quando necessario.

Em `test` e `production`, o projeto usa `Cloudflare Secrets Store` via `secrets_store_secrets` no `wrangler.jsonc`.

Por isso, uma lista vazia de secrets classicos no Worker nao deve ser interpretada sozinha como ausencia de segredos no ambiente.

Para split, o registry usa `splitConfigBindings`:

- `depixSplitAddress`
- `splitFee`

Os valores reais desses bindings ficam no Cloudflare Secrets Store em `test` e `production`, ou em `.dev.vars` no ambiente local.

O mesmo principio vale para `OPS_ROUTE_BEARER_TOKEN`: ele nao deve entrar em `vars` versionadas nem em codigo. Em ambientes publicados, a recomendacao e materializa-lo como secret do Worker ou via Secrets Store.

Quando o time quiser reduzir blast radius por tenant, o runtime tambem aceita um binding tenant-scoped com precedencia sobre o token global:

- `OPS_ROUTE_BEARER_TOKEN_<TENANT_NORMALIZADO>`

Normalizacao atual:

- converte para maiusculas
- troca caracteres fora de `[A-Z0-9]` por `_`

Exemplo:

- `alpha` -> `OPS_ROUTE_BEARER_TOKEN_ALPHA`
- `cliente-beta` -> `OPS_ROUTE_BEARER_TOKEN_CLIENTE_BETA`

Se o binding tenant-scoped existir, ele vale apenas para o `tenantId` correspondente e substitui o fallback global naquela rota.

## Contrato de habilitacao

- `ENABLE_OPS_DEPOSIT_RECHECK=false` ou ausente: a rota operacional responde `503 ops_route_disabled`
- `ENABLE_OPS_DEPOSIT_RECHECK=true` sem token configurado: a rota continua desabilitada com `503 ops_route_disabled`
- `ENABLE_OPS_DEPOSIT_RECHECK=true` com token global: a rota fica habilitada para o fluxo atual
- `ENABLE_OPS_DEPOSIT_RECHECK=true` com token tenant-scoped: o tenant correspondente exige o token proprio e deixa de aceitar o fallback global

## Ambientes de lancamento

- `local`: pode habilitar para desenvolvimento e testes locais
- `test`: deve receber `ENABLE_OPS_DEPOSIT_RECHECK=true` e o token operacional antes da validacao real
- `production`: deve receber `ENABLE_OPS_DEPOSIT_RECHECK=true` e o token operacional antes de qualquer uso de suporte

Sem esses bindings, o deploy do codigo nao torna a rota operacional utilizavel por acidente.

## Onboarding de novo tenant

- por padrao, novo tenant continua herdando o token global `OPS_ROUTE_BEARER_TOKEN`
- quando o time quiser isolar esse tenant, provisiona `OPS_ROUTE_BEARER_TOKEN_<TENANT_NORMALIZADO>`
- se o binding tenant-scoped estiver declarado e invalido, a rota falha fechada com `503 ops_route_disabled` ate a configuracao ser corrigida

## Regra operacional

Secrets e dados financeiros operacionais nao devem morar em codigo, `vars` versionadas ou arquivos reais commitados.

## Regra de leitura

Configuracao de ambiente e segredo por tenant sao parte da arquitetura, nao detalhe de deploy.
