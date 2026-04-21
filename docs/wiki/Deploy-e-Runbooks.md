# Deploy e Runbooks

## Scripts relevantes

- `npm run dev`
- `npm run typecheck`
- `npm test`
- `npm run cf:types`
- `npm run db:migrate:local`
- `npm run db:query:local`
- `npm run deploy:test`
- `npm run deploy:production`
- `node scripts/collect-qr-flow-evidence.mjs --env <test|production> [--tenant alpha|beta] [--since ISO] [--order-id ORDER_ID] [--deposit-entry-id DEPOSIT_ENTRY_ID] [--limit N]`

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
- `POST /webhooks/eulen/:tenantId/deposit` ja processa o webhook principal da Eulen e pode acionar notificacao assincrona no Telegram quando o pagamento for conciliado
- `POST /ops/:tenantId/recheck/deposit` ja consulta `deposit-status`, persiste o evento `recheck_deposit_status`, reconcilia `deposits` + `orders` e pode acionar notificacao assincrona no Telegram sem bloquear a resposta da rota
- `POST /ops/:tenantId/reconcile/deposits` ja consulta `deposits`, persiste eventos `recheck_deposits_list`, reconcilia linhas compactas por `qrId` e pode acionar notificacao assincrona no Telegram por linha reparada
- o Worker Module expoe `scheduled(controller, env, ctx)` para reconciliação agendada bounded de depositos Telegram pendentes; nesta etapa o cron fica ativo apenas em `test` e production continua com `triggers.crons = []`
- as rotas de diagnostico operacional existem, mas ficam fechadas por padrao e dependem de `ENABLE_LOCAL_DIAGNOSTICS=true`
- as rotas de webhook do Telegram em `/ops/:tenantId/telegram/*` sao operacionais de verdade: exigem `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>` e podem ser usadas em `test` e `production`
- o coletor de evidencia pos-QR agora aceita filtros combinaveis por `--order-id` e `--deposit-entry-id`
- o relatorio de evidencia agora inclui `deposit_events` sem `raw_payload`
- o relatorio de evidencia agora expõe uma secao `Ops readiness` derivada de `/health.operations.depositRecheck` e `/health.operations.depositsFallback`
- a validacao de tipos do Worker passou a ter comando canonico via `npm run typecheck`
- a verificacao de tipos gerados do Cloudflare Worker passou a ser parte do fluxo de manutencao com `npm run cf:types`

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
- quando o agregado passar para estado de pagamento confirmado, a notificacao Telegram pode ser disparada em background; o recheck nao deve depender do envio para responder com sucesso

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

## Reconciliacao agendada de depositos

- pre-condicao de rollout: `ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION=true`
- mecanismo: Cloudflare Cron Triggers no Worker Module via `scheduled(controller, env, ctx)`
- contrato async: o handler usa `ctx.waitUntil(...)`; nao cria rota HTTP e nao depende de bearer `/ops`
- ambiente `test`: cron `*/15 * * * *` em UTC
- ambiente `production`: `triggers.crons = []` nesta PR; habilitacao real fica para a issue #126
- selecao por tenant: no maximo 5 depositos por execucao
- janela: depositos Telegram pendentes nas ultimas 2 horas, com `orders.current_step = "awaiting_payment"`, `orders.status = "pending"` e `deposits.external_status = "pending"`
- fonte de verdade: chamada direta ao service idempotente `processDepositRecheck`, que consulta `deposit-status`
- trilha local: eventos `deposit_events.source = "recheck_deposit_status"`
- controle de overlap: antes da chamada remota, o cron grava um claim condicional em `scheduled_deposit_reconciliation_claims`; execucoes concorrentes ou retries nao processam a mesma linha fresca duas vezes
- isolamento de estado: o lock do cron fica fora de `deposits.external_status`, entao leitores/escritores normais continuam vendo apenas o status de negocio do deposito
- recuperacao de claim: o claim e removido ao final do processamento, com ou sem erro; claims antigos podem ser retomados apos a janela de stale configurada no service
- notificacao: quando a reconciliacao muda o estado visivel para pagamento confirmado, a camada Telegram tenta notificar em modo fail-soft
- falha isolada: erro em um deposito ou tenant e logado e nao interrompe os demais
- idempotencia: reexecucao com a mesma verdade remota nao duplica `deposit_events`

## Operacao do cron

- para desligar runtime sem deploy de codigo, mantenha `ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION=false`
- em `test`, o cron e versionado no `wrangler.jsonc`; a validacao de rollout deve considerar o caminho do Worker e o estado de `/health`
- em `production`, o cron permanece ausente por design nesta PR; nao use o ambiente para habilitacao manual antecipada
- se o scheduler apresentar overlap ou repeticao, verifique primeiro claims antigos em `scheduled_deposit_reconciliation_claims` antes de suspeitar de duplicacao em `deposits`
- a operacao nao deve usar `OPS_ROUTE_BEARER_TOKEN` para o cron; o gating e feito por flag, D1 e bindings por tenant
- a leitura de readiness do cron deve vir de `/health.operations.scheduledDepositReconciliation`

## Runbook minimo

1. Confirmar `GET /health`.
2. Verificar `scheduledDepositReconciliation.state`.
3. Validar se `test` possui cron ativo e `production` continua sem triggers.
4. Rodar `npm run typecheck` e `npm test` antes de promover qualquer ajuste de runtime.
5. Em caso de incidente, revisar logs do Worker e o estado da tabela `scheduled_deposit_reconciliation_claims`.
