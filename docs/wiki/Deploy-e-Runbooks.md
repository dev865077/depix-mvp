# Deploy e Runbooks

## Scripts relevantes

- `npm run dev`
- `npm test`
- `npm run cf:types`
- `npm run db:migrate:local`
- `npm run db:query:local`
- `npm run deploy:test`
- `npm run deploy:production`

## Endpoints operacionais

- `GET /health`
- `POST /telegram/:tenantId/webhook`
- `POST /webhooks/eulen/:tenantId/deposit`
- `POST /ops/:tenantId/recheck/deposit`

## Estado atual do `main`

- `GET /health` responde
- as fronteiras canonicas de rota ja existem
- webhook Eulen e recheck ainda sao placeholders

## Verificacao minima

- confirmar `GET /health`
- confirmar `tenantId` no path das rotas multi-tenant
- confirmar bindings do tenant
- nunca logar tokens nem secrets

## Regra de operacao

Runbook curto e executavel vale mais do que texto operacional longo e desatualizado.
