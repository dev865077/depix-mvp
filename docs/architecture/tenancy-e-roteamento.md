# Tenancy e Roteamento

## Objetivo

Explicar como o projeto identifica o parceiro certo em cada request e como esse contrato ja aparece no codigo atual.

## Regra central

O sistema e multi-tenant por `tenantId`, com isolamento logico dentro de um unico Worker e de um unico banco.

## Onde o tenant entra

O `tenantId` e resolvido no path:

- `/telegram/:tenantId/webhook`
- `/webhooks/eulen/:tenantId/deposit`
- `/ops/:tenantId/recheck/deposit`

## Registro de tenants

O binding `TENANT_REGISTRY` descreve os tenants nao sensiveis. Cada tenant define:

- `displayName`
- `eulenPartnerId`
- nomes dos secret bindings do tenant

## Secrets por tenant

Cada tenant aponta para bindings secretos separados:

- `telegramBotToken`
- `telegramWebhookSecret`
- `eulenApiToken`
- `eulenWebhookSecret`

No codigo, esses bindings sao resolvidos em `src/config/tenants.js`.

## Tenants de exemplo

No repositorio atual, `alpha` e `beta` sao tenants ficticios usados para configuracao e teste. Eles nao representam parceiros reais.

## Efeito operacional desse desenho

- cada bot Telegram aponta para sua propria URL de webhook
- cada conta Eulen fica isolada por tenant
- a camada HTTP nao precisa adivinhar parceiro por payload
- suporte e troubleshooting ficam mais claros porque o tenant ja entra na URL
