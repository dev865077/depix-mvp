# Tenancy e Roteamento

## Regra central

O sistema e multi-tenant por `tenantId`, com isolamento logico dentro de um unico Worker e de um unico banco.

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

## Tenants atuais

`alpha` e `beta` aparecem hoje como tenants configurados nos ambientes versionados do projeto.

Nao trate esses ids como meros placeholders sem validar o estado real de deploy, segredos e webhooks do ambiente correspondente.
