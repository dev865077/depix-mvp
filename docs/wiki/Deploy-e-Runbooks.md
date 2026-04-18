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
- header obrigatorio: `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>`
- ancora local: `depositEntryId`
- fonte de verdade remota: `deposit-status`
- trilha local: evento `deposit_events.source = "recheck_deposit_status"`
- efeito esperado: hidratar `qrId` quando necessario e aplicar o status reconciliado em `deposits` e `orders`
- persistencia critica: evento de auditoria + `deposits` + `orders` sao gravados no mesmo batch do D1 para reduzir risco de estado parcial

## Contrato operacional do recheck

- a rota so opera quando `OPS_ROUTE_BEARER_TOKEN` estiver configurado como segredo do Worker
- sem esse binding, `POST /ops/:tenantId/recheck/deposit` responde `503 ops_route_disabled`
- sem header Bearer, responde `401 ops_authorization_required`
- com token invalido, responde `403 ops_authorization_invalid`
- se o deposito nao existir no tenant informado, responde `404 deposit_not_found`
- se o agregado local estiver quebrado e o `order` nao existir, responde `409 order_not_found`
- se `deposit-status` devolver `qrId` ja associado a outro deposito, responde `409 deposit_qr_id_conflict`
- se `deposit-status` divergir de um `qrId` ja correlacionado no deposito atual, responde `409 deposit_qr_id_mismatch`
- se o agregado local ja estiver concluido e `deposit-status` voltar com estado inferior nao terminal, responde `409 deposit_status_regression`
- se a Eulen nao responder com um `status` utilizavel, responde `502 deposit_status_invalid_response`
- se a consulta remota falhar, responde `502 deposit_status_unavailable`
- recheck repetido com a mesma verdade remota e idempotente: nao duplica `deposit_events` e pode apenas reparar o agregado se um estado historico tiver ficado incompleto

## Retry e precedencia

- esta rota e uma ferramenta manual de suporte, nao substitui o webhook principal nem o fallback futuro por `deposits`
- retry manual depois de `502 deposit_status_unavailable` e permitido
- retry manual depois de `409 deposit_status_regression`, `409 deposit_qr_id_conflict` ou `409 deposit_qr_id_mismatch` nao deve ser tratado como tentativa cega; primeiro e preciso entender a divergencia
- quando o agregado local ja estiver concluido por `depix_sent`, o recheck nao aceita um `deposit-status` atrasado que volte com `pending`, `under_review` ou outro estado inferior

## Rollout e rollback

- rollout: provisionar `OPS_ROUTE_BEARER_TOKEN` apenas nos ambientes que devem expor a ferramenta operacional, publicar o deploy e validar um smoke test autenticado com um `depositEntryId` conhecido
- rollback rapido: remover ou rotacionar `OPS_ROUTE_BEARER_TOKEN`; a rota passa a devolver `503 ops_route_disabled` sem afetar webhook principal, Telegram ou leitura de saude
- rollback funcional: mesmo sem usar a rota, o caminho principal de confirmacao continua sendo o webhook da Eulen

## Verificacao minima

- confirmar `GET /health`
- confirmar `tenantId` no path das rotas multi-tenant
- confirmar bindings do tenant
- confirmar se `test` e `production` estao usando `Cloudflare Secrets Store` como esperado
- confirmar se a validacao local de diagnostico esta desabilitada em ambientes publicos
- nunca logar tokens nem secrets

## Regra de operacao

Runbook curto e executavel vale mais do que texto operacional longo e desatualizado.
