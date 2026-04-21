# Deploy e Runbooks

## Scripts relevantes

- `npm run dev`
- `npm run typecheck`
- `npm run test`
- `npm run cf:types`
- `npm run db:migrate:local`
- `npm run db:query:local`
- `npm run telegram:preflight -- --env <test|production> --tenant alpha|beta --out artifacts/telegram-real-flow/preflight.json`
- `npm run telegram:real-run -- --env <test|production> --tenant alpha|beta --amount-brl 3 --wallet <lq1|ex1> --confirm-real --out artifacts/telegram-real-flow/real-run.json`
- `npm run deploy:test`
- `npm run deploy:production`
- `node scripts/collect-qr-flow-evidence.mjs --env <test|production> [--tenant alpha|beta] [--since ISO] [--order-id ORDER_ID] [--deposit-entry-id DEPOSIT_ENTRY_ID] [--limit N] [--require-split-proof]`

## Hosts publicos canonicos

- `test`: `https://depix-mvp-test.dev865077.workers.dev`
- `production`: `https://depix-mvp-production.dev865077.workers.dev`

O host `https://depix-mvp.dev865077.workers.dev` nao e o endpoint publico canonico deste repositorio. Para validacao operacional, smoke test e evidencia de issue, use sempre os hosts acima.

## Endpoints operacionais

- `GET /health`
- `POST /telegram/:tenantId/webhook`
- `GET /webhooks/eulen/:tenantId/deposit`
- `HEAD /webhooks/eulen/:tenantId/deposit`
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
- `GET /webhooks/eulen/:tenantId/deposit` e `HEAD /webhooks/eulen/:tenantId/deposit` agora respondem como probe diagnostico do webhook canonico da Eulen, sem entrar no processamento real
- `POST /webhooks/eulen/:tenantId/deposit` ja processa o webhook principal da Eulen e pode acionar notificacao assincrona no Telegram quando o pagamento for conciliado
- `POST /ops/:tenantId/recheck/deposit` ja consulta `deposit-status`, persiste o evento `recheck_deposit_status`, reconcilia `deposits` + `orders` e pode acionar notificacao assincrona no Telegram sem bloquear a resposta da rota
- `POST /ops/:tenantId/reconcile/deposits` ja consulta `deposits`, persiste eventos `recheck_deposits_list`, reconcilia linhas compactas por `qrId` e pode acionar notificacao assincrona no Telegram por linha reparada
- o Worker Module expoe `scheduled(controller, env, ctx)` para reconciliação agendada bounded de depositos Telegram pendentes; `test` e `production` rodam a cada 15 minutos com janela maxima de 2 horas e limite de 5 depositos por tenant/rodada
- `test` e `production` habilitam `ENABLE_OPS_DEPOSIT_RECHECK=true` e `ENABLE_OPS_DEPOSITS_FALLBACK=true`; ambas as rotas continuam inacessiveis sem `OPS_ROUTE_BEARER_TOKEN`
- as rotas de diagnostico operacional existem, mas ficam fechadas por padrao e dependem de `ENABLE_LOCAL_DIAGNOSTICS=true`
- as rotas de webhook do Telegram em `/ops/:tenantId/telegram/*` sao operacionais de verdade: exigem `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>` e podem ser usadas em `test` e `production`
- o coletor de evidencia pos-QR agora aceita filtros combinaveis por `--order-id` e `--deposit-entry-id`
- o relatorio de evidencia agora inclui `deposit_events` sem `raw_payload`
- o relatorio de evidencia agora expõe uma secao `Ops readiness` derivada de `health.configuration.operations.depositRecheck` e `health.configuration.operations.depositsFallback`; para compatibilidade, o formato legado em `health.operations` continua aceito
- o relatorio de evidencia agora expõe uma secao `splitProof` para explicitar lacunas de split-audit e distinguir estados como `missing_split_config`, `pending_settlement`, `missing_onchain_tx` e `proved`
- o coletor de evidencia tambem inclui os campos persistidos de split nas ordens consultadas para sustentar esse resumo auditavel
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
- efeito esperado: hidratar `qrId` quando necessario, preservar `bankTxId` e `blockchainTxId` quando o contrato remoto os devolver, e aplicar o status reconciliado em `deposits` e `orders`
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

## Reconciliação agendada de depositos pendentes

- pre-condicao de rollout: `ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION=true`
- roda apenas em `test` e `production`
- janela maxima de busca: 2 horas
- limite por rodada: 5 depositos por tenant
- fonte de verdade da busca: `deposits` pendentes por tenant
- efeito esperado: consultar `deposits`, persistir `recheck_deposits_list`, reconciliar por `qrId` e disparar notificacao assincrona quando houver confirmacao visivel
- a reconciliacao agendada nao exige `OPS_ROUTE_BEARER_TOKEN`, porque nao passa por HTTP

## Contrato operacional da reconciliacao agendada

- sem `ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION=true`, o cron faz skip operacional e nao chama Eulen
- em `test` e `production`, a rotacao ocorre a cada 15 minutos
- o fluxo continua bounded e idempotente por tenant, para evitar tempestade de chamadas no mesmo conjunto de depositos
- a habilitacao do cron nao substitui o webhook principal nem o recheck operacional; ela existe como rede de seguranca para depositos pendentes

## Webhook Telegram operacional

- `GET /ops/:tenantId/telegram/webhook-info` retorna o estado da configuracao do webhook Telegram do tenant
- `POST /ops/:tenantId/telegram/register-webhook` registra o webhook canonico do Telegram para o tenant
- ambas as rotas exigem `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>`
- o contrato operacional aceita o webhook canonico com `allowed_updates` incluindo `callback_query`
- os comandos publicos canonicos do Telegram para o setup sao `/start`, `/help`, `/status` e `/cancel`

## Regras de manutencao

- se uma mudanca alterar ambiente, segredo, integracao, contrato operacional ou runbook de rollout, esta pagina deve ser atualizada na mesma PR
- nao documentar endpoints, flags ou segredos que nao estejam no codigo ou no contrato operativo verificado
