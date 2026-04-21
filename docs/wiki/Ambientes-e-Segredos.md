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

- `OPS_ROUTE_BEARER_TOKEN` para autenticar chamadas manuais no namespace `/ops`, incluindo recheck, fallback e operacoes de webhook do Telegram

Tambem existe uma flag operacional explicita:

- `ENABLE_OPS_DEPOSIT_RECHECK=true` para habilitar de fato `POST /ops/:tenantId/recheck/deposit`
- `ENABLE_OPS_DEPOSITS_FALLBACK=true` para habilitar de fato `POST /ops/:tenantId/reconcile/deposits`

## Como o runtime resolve isso

O registro nao sensivel fica em `TENANT_REGISTRY`. Cada tenant aponta para nomes de bindings secretos, e o runtime materializa esses valores quando necessario.

Em `test` e `production`, o projeto usa `Cloudflare Secrets Store` via `secrets_store_secrets` no `wrangler.jsonc`.

Por isso, uma lista vazia de secrets classicos no Worker nao deve ser interpretada sozinha como ausencia de segredos no ambiente.

O contrato de tenancy foi endurecido para usar contratos compartilhados em `src/types/` e validacao fail-closed no parser de runtime. O runtime continua responsavel por validar e materializar o registry; os tipos servem como contrato estatico para o restante do codigo.

Para split, o registry usa `splitConfigBindings`:

- `depixSplitAddress`
- `splitFee`

Os valores reais desses bindings ficam no Cloudflare Secrets Store em `test` e `production`, ou em `.dev.vars` no ambiente local.

O mesmo principio vale para `OPS_ROUTE_BEARER_TOKEN`: ele nao deve entrar em `vars` versionadas nem em codigo. Em ambientes publicados, a recomendacao e materializa-lo como secret do Worker ou via Secrets Store.

Quando o time quiser reduzir blast radius por tenant, o binding tenant-scoped deixa de ser derivado do `tenantId` e passa a ser declarado explicitamente no `TENANT_REGISTRY`:

```json
{
  "opsBindings": {
    "depositRecheckBearerToken": "NOME_DO_BINDING_SECRETO"
  }
}
```

Se `depositRecheckBearerToken` existir no tenant, esse binding vale apenas para aquele tenant e substitui o fallback global naquela rota.

## Contrato de habilitacao

- regra unica de precedencia: todo tenant usa o token global `OPS_ROUTE_BEARER_TOKEN` por padrao; somente tenants que declararem `opsBindings.depositRecheckBearerToken` saem desse caminho, e esse override afeta apenas o tenant declarado
- `ENABLE_OPS_DEPOSIT_RECHECK=false` ou ausente: a rota operacional responde `503 ops_route_disabled`
- `ENABLE_OPS_DEPOSIT_RECHECK=true` sem token configurado: a rota continua desabilitada com `503 ops_route_disabled`
- `ENABLE_OPS_DEPOSIT_RECHECK=true` com `OPS_ROUTE_BEARER_TOKEN` configurado: a rota fica operacionalmente pronta
- `ENABLE_OPS_DEPOSIT_RECHECK=true` com `opsBindings.depositRecheckBearerToken`: o tenant correspondente exige o token proprio e deixa de aceitar o fallback global
- `ENABLE_OPS_DEPOSITS_FALLBACK=false` ou ausente: o fallback por janela responde `503 ops_deposits_fallback_disabled`, mesmo que o recheck por deposito esteja habilitado
- `ENABLE_OPS_DEPOSITS_FALLBACK=true` usa o mesmo bearer operacional, mas abre apenas `POST /ops/:tenantId/reconcile/deposits`

## Ambientes de lancamento

- `local`: pode habilitar para desenvolvimento e testes locais
- `test`: deve receber a flag da rota operacional desejada (`ENABLE_OPS_DEPOSIT_RECHECK=true` e/ou `ENABLE_OPS_DEPOSITS_FALLBACK=true`) e o token operacional por configuracao de ambiente antes da validacao real; o valor nao fica ligado no `wrangler.jsonc` versionado
- `production`: deve receber a flag da rota operacional desejada (`ENABLE_OPS_DEPOSIT_RECHECK=true` e/ou `ENABLE_OPS_DEPOSITS_FALLBACK=true`) e o token operacional por configuracao de ambiente antes de qualquer uso de suporte; o valor nao fica ligado no `wrangler.jsonc` versionado

Sem esses bindings, o deploy do codigo nao torna a rota operacional utilizavel por acidente.

## Onboarding de novo tenant

- por padrao, novo tenant continua herdando o token global `OPS_ROUTE_BEARER_TOKEN`
- quando o time quiser isolar esse tenant, declara `opsBindings.depositRecheckBearerToken` no `TENANT_REGISTRY` e provisiona esse binding secreto no ambiente
- se o binding tenant-scoped estiver declarado e invalido, a rota falha fechada com `503 ops_route_disabled` ate a configuracao ser corrigida
- a validacao do registry tambem falha fechada em lookup quando encontra contrato malformado, em vez de continuar com dados parcialmente normalizados

## Regra operacional

Secrets e dados financeiros operacionais nao devem morar em codigo, `vars` versionadas ou arquivos reais commitados.
