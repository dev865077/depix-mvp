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

## Runbook da prova operacional 0.1

Este runbook e o procedimento canonico para decidir se a release `0.1` pode avancar com uma compra real controlada em `Alpha Production`.

### Pre-requisitos

- Worker `production` publicado no host canonico `https://depix-mvp-production.dev865077.workers.dev`.
- `/health` em `production` com `status=ok`.
- Tenant `alpha` com segredos de Telegram, Eulen e split configurados.
- Webhook Eulen registrado para `https://depix-mvp-production.dev865077.workers.dev/webhooks/eulen/alpha/deposit`.
- Webhook Telegram registrado para `https://depix-mvp-production.dev865077.workers.dev/telegram/alpha/webhook`.
- `ENABLE_OPS_DEPOSIT_RECHECK=true`, `ENABLE_OPS_DEPOSITS_FALLBACK=true` e `ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION=true` em `production`.
- Operador com acesso ao bot Telegram Alpha Production, SideSwap/Liquid e ao recibo Eulen da transacao.

### Passo a passo

1. Rodar o preflight:

   ```bash
   npm run telegram:preflight -- --env production --tenant alpha --out artifacts/telegram-real-flow/preflight-production-alpha.json
   ```

2. Confirmar que `/health` mostra `depositRecheck.ready=true`, `depositsFallback.ready=true` e `scheduledDepositReconciliation.ready=true`.
3. Iniciar conversa nova no bot Alpha Production com `/start`.
4. Usar o CTA `Comprar DePix`.
5. Informar um valor baixo em BRL sem centavos, por exemplo `3`.
6. Informar um endereco DePix/Liquid valido `lq1` ou `ex1`.
7. Confirmar pelo botao `Confirmar`.
8. Pagar o Pix gerado.
9. Aguardar a mensagem final do bot informando pagamento confirmado.
10. Coletar evidencia do fluxo com filtros por `orderId` ou janela curta:

   ```bash
   node scripts/collect-qr-flow-evidence.mjs --env production --tenant alpha --since <ISO_DA_EXECUCAO> --require-split-proof
   ```

11. Anexar a evidencia na issue de validacao manual da release.

### Checkpoints observaveis

- Telegram aceitou `/start` e mostrou o CTA `Comprar DePix`.
- O pedido saiu de `amount` para `wallet`, depois para `confirmation`.
- A confirmacao criou QR/Pix e persistiu `orderId`, `depositEntryId` e `qrId`.
- O webhook Eulen ou o caminho de recheck/fallback registrou um evento em `deposit_events`.
- O pedido local chegou a estado final confirmado.
- A notificacao Telegram de pagamento confirmado foi enviada ou teve falha explicada em log estruturado.
- A evidencia coletada inclui `requestId`, `tenantId`, `telegramUserId`, `orderId`, `qrId`, status do webhook e status final do pedido.

### Logs e telemetria

Use estes sinais para diagnostico:

- `/health`: prontidao operacional de `depositRecheck`, `depositsFallback` e `scheduledDepositReconciliation`.
- `deposit_events.source=webhook`: confirmacao recebida diretamente da Eulen.
- `deposit_events.source=recheck_deposit_status`: confirmacao reparada pela rota de recheck.
- `deposit_events.source=recheck_deposits_list`: confirmacao reparada por fallback de lista.
- `telegram.payment_notification.sent`: notificacao de sucesso enviada ao usuario.
- `telegram.payment_notification.failed` ou `telegram.payment_notification.skipped`: notificacao nao enviada, com motivo operacional.
- Relatorio de `scripts/collect-qr-flow-evidence.mjs`: consolidado de pedido, deposito, eventos, readiness operacional e `splitProof`.

### Validacao da reconciliacao Eulen

Compare a evidencia local com o recibo Eulen:

- `qrId` do recibo deve bater com o `qrId` local.
- Valor original deve bater com o valor do pedido.
- Valor enviado ao comprador deve bater com o que o bot concluiu.
- Taxa da Eulen deve estar explicita no recibo.
- Split address e split amount devem bater com o split configurado para o tenant.
- Quando houver `TxID`, `splitProof` deve sair de `pending_settlement` para `proved` assim que a evidencia on-chain estiver disponivel.

### Decisao final

Use uma destas decisoes:

- `pronto`: compra concluiu sem erro visivel, pedido local ficou confirmado, recibo Eulen bate com pedido local e a evidencia contem os IDs obrigatorios.
- `recheck`: pagamento foi feito, mas webhook principal nao conciliou; usar `POST /ops/:tenantId/recheck/deposit` com `depositEntryId` e anexar o resultado.
- `fallback`: recheck por deposito nao bastou; usar `POST /ops/:tenantId/reconcile/deposits` com janela curta e anexar o resultado.
- `falha`: nao houve reconciliacao confiavel, faltou evidencia obrigatoria ou o usuario viu erro durante a compra.

### Evidencia minima para anexar

- Arquivo de preflight.
- `requestId` principal da execucao.
- `orderId`, `depositEntryId` e `qrId`.
- Trecho ou arquivo do relatorio `collect-qr-flow-evidence`.
- Recibo Eulen ou campos relevantes do recibo.
- Decisao final: `pronto`, `recheck`, `fallback` ou `falha`.

### Validacao deste runbook

Status atual: `limitada`.

O procedimento esta publicado e cobre pre-requisitos, passos, checkpoints, logs, reconciliacao Eulen e criterios de decisao. A validacao so passa para `completa` quando a issue de prova manual anexar uma compra real em `Alpha Production` com os sinais obrigatorios.

## Webhook Telegram operacional

- `GET /ops/:tenantId/telegram/webhook-info` retorna o estado da configuracao do webhook Telegram do tenant
- `POST /ops/:tenantId/telegram/register-webhook` registra o webhook canonico do Telegram para o tenant
- ambas as rotas exigem `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>`
- o contrato operacional aceita o webhook canonico com `allowed_updates` incluindo `callback_query`
- os comandos publicos canonicos do Telegram para o setup sao `/start`, `/help`, `/status` e `/cancel`

## Regras de manutencao

- se uma mudanca alterar ambiente, segredo, integracao, contrato operacional ou runbook de rollout, esta pagina deve ser atualizada na mesma PR
- nao documentar endpoints, flags ou segredos que nao estejam no codigo ou no contrato operativo verificado
