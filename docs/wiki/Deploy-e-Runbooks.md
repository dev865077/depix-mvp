# Deploy e Runbooks

## Scripts relevantes

- `npm run dev`
- `npm test`
- `npm run cf:types`
- `npm run db:migrate:local`
- `npm run db:query:local`
- `npm run deploy:test`
- `npm run deploy:production`
- `node scripts/collect-qr-flow-evidence.mjs --env <test|production> [--tenant alpha|beta] [--since ISO]`

## Hosts publicos canonicos

- `test`: `https://depix-mvp-test.dev865077.workers.dev`
- `production`: `https://depix-mvp-production.dev865077.workers.dev`

O host `https://depix-mvp.dev865077.workers.dev` nao e o endpoint publico canonico deste repositorio. Para validacao operacional, smoke test e evidencia de issue, use sempre os hosts acima.

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

## Rollout de `orders.telegram_chat_id`

- a migracao adiciona `orders.telegram_chat_id` como coluna nullable e nao exige backfill destrutivo
- pedidos novos ou retomados pelo Telegram passam a gravar o `chat.id` real da conversa
- pedidos abertos legados com `telegram_chat_id = NULL` so ganham destino seguro quando receberem novo update Telegram do mesmo tenant, usuario e canal
- pedidos legados que nao receberem novo update permanecem sem destino assincrono seguro; a futura notificacao pos-pagamento deve registrar skip controlado e nunca usar `user_id` como fallback
- pedidos do canal `telegram` com `telegram_chat_id` valido agora recebem notificacao assincrona apenas quando o agregado financeiro confirma pagamento (`depix_sent` / `paid` + `completed`); duplicatas de webhook, recheck e fallback nao devem repetir a mesma mensagem
- no fallback por janela, cada linha reparada so pode disparar a mesma notificacao pos-pagamento quando aquele agregado tambem chegar em `depix_sent` / `paid` + `completed`; linhas fora desse estado nao notificam
- se um update conversacional chegar sem `chat.id`, o Worker falha fechado com `400 telegram_order_registration_failed` e `reason=missing_telegram_chat_id`, sem criar pedido parcial
- se um update chegar de chat diferente do persistido, o Worker nao sobrescreve `telegram_chat_id`, responde orientando usar a conversa original e registra `telegram.order.chat_divergence_detected`
- superficie order-bearing suportada no MVP: `message`/`message:text`; callback query, mensagem editada, channel post e demais updates recebem tratamento unsupported e nao criam nem retomam pedido

## Acao do operador por resposta

- `200 deposit_recheck_processed`: registrar `requestId`, `tenantId`, `depositEntryId` e `eventId` e seguir com a conciliacao concluida
- `400 telegram_order_registration_failed`: verificar se o update veio da superficie correta e se o payload possui `chat.id`
- `401 ops_authorization_required`: reenviar com Bearer valido
- `403 ops_authorization_invalid`: revisar token operacional informado
- `404 deposit_not_found`: conferir `tenantId` e `depositEntryId`
- `409 deposit_qr_id_conflict` ou `409 deposit_qr_id_mismatch`: investigar ownership e divergencia antes de repetir
- `502 deposit_status_unavailable` ou `502 deposit_status_invalid_response`: retry manual depois de checar a Eulen
- `503 ops_route_disabled` ou `503 telegram_webhook_dependency_unavailable`: revisar flags e secrets do ambiente antes de novo deploy
