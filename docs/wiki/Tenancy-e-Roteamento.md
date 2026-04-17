# Tenancy e Roteamento

## Regra central

O sistema e multi-tenant por `tenantId`, com isolamento logico dentro de um unico Worker e de um unico banco.

## Onde o tenant entra

- `/telegram/:tenantId/webhook`
- `/webhooks/eulen/:tenantId/deposit`
- `/ops/:tenantId/recheck/deposit`

## Registro de tenants

O binding `TENANT_REGISTRY` descreve:

- `displayName`
- `eulenPartnerId`
- nomes dos secret bindings por tenant

## Secrets por tenant

Cada tenant aponta para bindings separados de:

- token do bot Telegram
- secret do webhook Telegram
- token da Eulen
- secret do webhook Eulen

## Leitura de runtime

O projeto le o registro de tenants, valida sua forma e so materializa segredos quando eles sao realmente necessarios.

## Tenants de exemplo

`alpha` e `beta` sao tenants ficticios de configuracao e teste. Nao representam parceiros reais.
