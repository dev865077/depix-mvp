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
- `POST /ops/:tenantId/reconcile/deposits`
- `GET /ops/:tenantId/telegram/webhook-info`
- `POST /ops/:tenantId/telegram/register-webhook`
- `GET /ops/:tenantId/eulen/ping`
- `POST /ops/:tenantId/eulen/create-deposit`

## Estado atual do `main`

- `GET /health` responde com inventario publico redigido de tenants, sem expor mapas brutos de bindings ou nomes de bindings sensiveis
- as fronteiras canonicas de rota ja existem
- `POST /telegram/:tenantId/webhook` ja faz despacho real para `grammY`
- `POST /webhooks/eulen/:tenantId/deposit` ja processa o webhook principal da Eulen
- `POST /ops/:tenantId/recheck/deposit` ja consulta `deposit-status`, persiste o evento `recheck_deposit_status` e reconcilia `deposits` + `orders`
- `POST /ops/:tenantId/reconcile/deposits` ja consulta `deposits`, persiste eventos `recheck_deposits_list` e reconcilia linhas compactas por `qrId`
- as rotas de diagnostico operacional existem, mas ficam fechadas por padrao e dependem de `ENABLE_LOCAL_DIAGNOSTICS=true`
- as rotas de webhook do Telegram em `/ops/:tenantId/telegram/*` sao operacionais de verdade: exigem `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>` e podem ser usadas em `test` e `production`

## Recheck de deposito

- pre-condicao de rollout: `ENABLE_OPS_DEPOSIT_RECHECK=true`
- payload minimo: `{ "depositEntryId": "..." }`
- header obrigatorio: `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>`
- opcional com menor blast radius: `Authorization: Bearer <binding declarado em opsBindings.depositRecheckBearerToken>`
- ancora local: `depositEntryId`
- fonte de verdade remota: `deposit-status`
- trilha local: evento `deposit_events.source = "recheck_deposit_status"`
- efeito esperado: hidratar `qrId` quando necessario e aplicar o status reconciliado em `deposits` e `orders`
- persistencia critica: evento de auditoria + `deposits` + `orders` sao gravados no mesmo batch do D1 para reduzir risco de estado parcial

## Contrato operacional do recheck

- sem `ENABLE_OPS_DEPOSIT_RECHECK=true`, responde `503 ops_route_disabled`
- a rota fica globalmente pronta quando `ENABLE_OPS_DEPOSIT_RECHECK=true` e `OPS_ROUTE_BEARER_TOKEN` estiver configurado como segredo do Worker
- quando o tenant declarar `opsBindings.depositRecheckBearerToken`, esse token tenant-scoped tem precedencia sobre o token global
- tenant sem override declarado continua usando o token global; tenant com override declarado so usa o binding proprio e responde `503 ops_route_disabled` se esse segredo estiver ausente ou invalido
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

- esta rota e uma ferramenta manual de suporte para um deposito especifico; nao substitui o webhook principal nem o fallback por janela via `deposits`
- retry manual depois de `502 deposit_status_unavailable` e permitido
- retry manual depois de `409 deposit_status_regression`, `409 deposit_qr_id_conflict` ou `409 deposit_qr_id_mismatch` nao deve ser tratado como tentativa cega; primeiro e preciso entender a divergencia
- quando o agregado local ja estiver concluido por `depix_sent`, o recheck nao aceita um `deposit-status` atrasado que volte com `pending`, `under_review` ou outro estado inferior

## Webhook do Telegram

- `GET /ops/:tenantId/telegram/webhook-info` exige `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>`
- `POST /ops/:tenantId/telegram/register-webhook` exige o mesmo bearer operacional
- `GET /ops/:tenantId/telegram/webhook-info` consulta `getMe` e `getWebhookInfo` com o token real do tenant
- `GET /ops/:tenantId/telegram/webhook-info` aceita apenas o query param canonico `publicBaseUrl` quando o operador quiser comparar a URL publica esperada
- `POST /ops/:tenantId/telegram/register-webhook` chama `setWebhook` com `secret_token` do tenant e `allowed_updates=["message"]`
- no `register-webhook`, `publicBaseUrl` e obrigatoria no corpo JSON; a rota nao infere host automaticamente para evitar registrar o bot contra a origin errada
- migracao operacional: os endpoints antigos de diagnostico local nao sao mais a ferramenta de suporte para webhook; o contrato canonico agora e sempre `/ops/:tenantId/telegram/*` com bearer operacional e `publicBaseUrl` explicita quando houver comparacao ou mutacao de endpoint
- em `production`, sempre confirmar explicitamente a base publica desejada antes de chamar `register-webhook`
- se o ambiente nao materializar `telegramBotToken` ou `telegramWebhookSecret`, a rota falha fechada com `503 telegram_webhook_dependency_unavailable`
- se o bearer estiver ausente ou invalido, responde `401 ops_authorization_required` ou `403 ops_authorization_invalid`

## Acao do operador por resposta

- `200 deposit_recheck_processed`: registrar `requestId`, `tenantId`, `depositEntryId`, `eventId` e seguir com a conciliacao concluida
- `200 deposit_recheck_duplicate`: registrar `requestId` e tratar como replay idempotente; nao repetir indefinidamente
- `401 ops_authorization_required` ou `403 ops_authorization_invalid`: validar token, escopo do tenant e rotacao recente do segredo antes de qualquer nova tentativa
- `404 deposit_not_found`: confirmar se o `depositEntryId` pertence ao tenant do path; nao insistir com outro tenant no mesmo request
- `409 order_not_found`: tratar como agregado local quebrado e abrir correcao de dados antes de novo recheck
- `409 deposit_qr_id_conflict` ou `409 deposit_qr_id_mismatch`: parar retries cegos, anexar `requestId` e investigar correlacao local versus resposta remota
- `409 deposit_status_regression`: preservar o agregado concluido local, registrar a divergencia e comparar webhook/eventos antes de qualquer acao manual
- `502 deposit_status_invalid_response` ou `502 deposit_status_unavailable`: confirmar disponibilidade da Eulen e do binding do tenant antes de repetir a operacao
- `503 telegram_webhook_dependency_unavailable`: conferir se `telegramBotToken` e `telegramWebhookSecret` foram materializados para o tenant antes de tentar registrar ou consultar o webhook
