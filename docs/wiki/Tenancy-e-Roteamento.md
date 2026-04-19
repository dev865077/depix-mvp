# Tenancy e Roteamento

## Regra central

O sistema e multi-tenant por `tenantId`, com isolamento logico dentro de um unico Worker e de um unico banco.

`tenantId` sozinho nao representa permissao operacional. Nas rotas manuais de suporte, ele define apenas o escopo do agregado que sera lido ou reconciliado.

## Onde o tenant entra

- `/telegram/:tenantId/webhook`
- `/webhooks/eulen/:tenantId/deposit`
- `/ops/:tenantId/recheck/deposit`
- `/ops/:tenantId/telegram/webhook-info`
- `/ops/:tenantId/telegram/register-webhook`
- `/ops/:tenantId/eulen/ping`
- `/ops/:tenantId/eulen/create-deposit`

## Registro de tenants

O binding `TENANT_REGISTRY` descreve:

- `displayName`
- `eulenPartnerId`
- nomes dos secret bindings por tenant
- nomes dos bindings de split em `splitConfigBindings`

## Secrets por tenant

Cada tenant aponta para bindings separados de:

- token do bot Telegram
- secret do webhook Telegram
- token da Eulen
- secret do webhook Eulen
- endereco DePix/Liquid de split
- percentual de split

## Leitura de runtime

O projeto le o registro de tenants, valida sua forma e so materializa segredos quando eles sao realmente necessarios. O split usado em `deposit` nunca deve vir do request do operador; ele vem do tenant resolvido e de seus bindings secretos.

O endpoint `GET /health` publica um inventario redigido de tenants: ele confirma existencia e metadados basicos, mas nao expoe mapas brutos de bindings nem nomes de bindings sensiveis.

## Tenants atuais

`alpha` e `beta` aparecem hoje como tenants configurados nos ambientes versionados do projeto.

Nao trate esses ids como meros placeholders sem validar o estado real de deploy, segredos e webhooks do ambiente correspondente.

Para `POST /ops/:tenantId/recheck/deposit` e para as rotas de webhook do Telegram em `/ops/:tenantId/telegram/*`, o isolamento por tenant e combinado com autenticacao explicita de operador via `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>`.

Nas rotas `/ops/:tenantId/telegram/*`, o `tenantId` continua apenas delimitando qual bot e quais segredos serao usados. Ele nunca substitui a autenticacao do operador.
