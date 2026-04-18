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
- `GET /ops/:tenantId/telegram/webhook-info`
- `POST /ops/:tenantId/telegram/register-webhook`
- `GET /ops/:tenantId/eulen/ping`
- `POST /ops/:tenantId/eulen/create-deposit`

## Estado atual do `main`

- `GET /health` responde
- as fronteiras canonicas de rota ja existem
- `POST /telegram/:tenantId/webhook` ja faz despacho real para `grammY`
- `POST /webhooks/eulen/:tenantId/deposit` ja processa o webhook principal da Eulen
- `POST /ops/:tenantId/recheck/deposit` ja consulta `deposit-status`, persiste o evento `recheck_deposit_status` e reconcilia `deposits` + `orders`
- as rotas de diagnostico operacional existem, mas ficam fechadas por padrao e dependem de `ENABLE_LOCAL_DIAGNOSTICS=true`

## Recheck de deposito

- payload minimo: `{ "depositEntryId": "..." }`
- ancora local: `depositEntryId`
- fonte de verdade remota: `deposit-status`
- trilha local: evento `deposit_events.source = "recheck_deposit_status"`
- efeito esperado: hidratar `qrId` quando necessario e aplicar o status reconciliado em `deposits` e `orders`

## Verificacao minima

- confirmar `GET /health`
- confirmar `tenantId` no path das rotas multi-tenant
- confirmar bindings do tenant
- confirmar se `test` e `production` estao usando `Cloudflare Secrets Store` como esperado
- confirmar se a validacao local de diagnostico esta desabilitada em ambientes publicos
- nunca logar tokens nem secrets

## Regra de operacao

Runbook curto e executavel vale mais do que texto operacional longo e desatualizado.
