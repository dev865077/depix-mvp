# Deploy e Runbooks

## Aviso de transicao

Os comandos abaixo ainda descrevem o monolito `depix-mvp`, que segue operacional ate o cutover. No modelo alvo:

- deploy e rollback do bot ficam no repositorio `debot`
- deploy e rollback da superficie financeira ficam no repositorio `api`
- workflows e automacoes de GitHub ficam no repositorio `github-automation`

Enquanto o split do track `#674` nao estiver concluido, use este runbook para operar `depix-mvp`. Depois do cutover, qualquer referencia ao monolito deve ser removida ou mantida apenas como historico com link para o repositorio substituto.

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
- `POST /ops/:tenantId/reconcile/deposits` (legado; pendente de remocao em `#585`)
- `GET /ops/:tenantId/telegram/webhook-info`
- `POST /ops/:tenantId/telegram/register-webhook`
- `GET /ops/:tenantId/eulen/ping`
- `POST /ops/:tenantId/eulen/create-deposit`

## Estado atual do `main`

- a prova real Alpha Production pos payment-boundary registrada em `#688` passou com `orderStatus=paid`, `orderCurrentStep=completed`, `depositStatus=depix_sent`, `splitProof=proved` e notificacao final no Telegram
- a evidencia primaria da prova de `#688` esta em `artifacts/release-0.1/live-alpha-production-20260423T220428Z.json`; `#634` permanece como prova historica anterior em `artifacts/release-0.1/live-alpha-production-20260423T101726Z.json`
- `GET /health` responde com inventario publico redigido de tenants, sem expor mapas brutos de bindings ou nomes de bindings sensiveis
- as fronteiras canonicas de rota ja existem
- `POST /telegram/:tenantId/webhook` ja faz despacho real para `grammY`
- `GET /webhooks/eulen/:tenantId/deposit` e `HEAD /webhooks/eulen/:tenantId/deposit` agora respondem como probe diagnostico do webhook canonico da Eulen, sem entrar no processamento real
- `POST /webhooks/eulen/:tenantId/deposit` ja processa o webhook principal da Eulen e pode acionar notificacao assincrona no Telegram quando o pagamento for conciliado
- `POST /webhooks/eulen/:tenantId/deposit` agora grava `deposit_events` antes do batch atomico que atualiza `deposits` + `orders`, para nao perder evidencia se o agregado falhar no meio da escrita
- `POST /webhooks/eulen/:tenantId/deposit` agora atualiza `deposits` + `orders` em um unico `db.batch()`, reduzindo o risco de estado parcial entre as duas tabelas
- `POST /webhooks/eulen/:tenantId/deposit` e a borda de webhook do Telegram agora usam rate limit centralizado por `tenantId` e IP em ambiente nao local, com resposta `429` e `Retry-After` quando o limite e excedido
- `POST /webhooks/eulen/:tenantId/deposit` e `POST /telegram/:tenantId/webhook` nao aplicam espera de rate limit em `local`, para preservar testes e dev flows
- `POST /ops/:tenantId/recheck/deposit` ja consulta `deposit-status`, persiste o evento `recheck_deposit_status`, reconcilia `deposits` + `orders` e pode acionar notificacao assincrona no Telegram sem bloquear a resposta da rota
- `POST /ops/:tenantId/reconcile/deposits` ainda existe e consulta `deposits`, mas e legado e esta pendente de remocao em `#585`; o operador nao deve usar esse caminho como recuperacao primaria da 0.1
- o Worker Module ainda expoe `scheduled(controller, env, ctx)` para reconciliacao agendada bounded de depositos Telegram pendentes; esse cron esta pendente de remocao em `#585`
- `test` e `production` habilitam `ENABLE_OPS_DEPOSIT_RECHECK=true` e `ENABLE_OPS_DEPOSITS_FALLBACK=true`; ambas as rotas continuam inacessiveis sem `OPS_ROUTE_BEARER_TOKEN`, e `ENABLE_OPS_DEPOSITS_FALLBACK` segue pendente de remocao em `#585`
- as rotas de diagnostico operacional existem, mas ficam fechadas por padrao e dependem de `ENABLE_LOCAL_DIAGNOSTICS=true`
- as rotas de webhook do Telegram em `/ops/:tenantId/telegram/*` sao operacionais de verdade: exigem `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>` e podem ser usadas em `test` e `production`
- o coletor de evidencia pos-QR agora aceita filtros combinaveis por `--order-id` e `--deposit-entry-id`
- o relatorio de evidencia agora inclui `deposit_events` sem `raw_payload`
- o relatorio de evidencia agora expõe uma secao `Ops readiness` derivada de `health.configuration.operations.depositRecheck` e, enquanto `#585` estiver aberta, tambem de `health.configuration.operations.depositsFallback`; para compatibilidade, o formato legado em `health.operations` continua aceito
- o relatorio de evidencia agora expõe uma secao `splitProof` para explicitar lacunas de split-audit e distinguir estados como `missing_split_config`, `pending_settlement`, `missing_onchain_tx` e `proved`
- o coletor de evidencia tambem inclui os campos persistidos de split nas ordens consultadas para sustentar esse resumo auditavel
- o coletor de evidencia da release 0.1 agora tambem expõe `telegram_user_id`, `created_request_id` e `request_id` quando esses campos estiverem persistidos no fluxo consultado
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
- se o agregado mudar para `paid/completed`, o bot envia a notificacao final em background quando houver contexto Telegram persistido

## Runbook da prova operacional 0.1

Use este roteiro para repetir a prova real de `Alpha Production` ou para registrar nova evidencia de release.

1. Confirmar que o ambiente alvo e `production/alpha`.
2. Confirmar que migrations remotas estao limpas em `test` e `production`.
3. Executar ou registrar a limitacao do preflight canonico:

```bash
npm run release:0.1:check
```

4. Confirmar fora do codigo que o webhook Eulen de deposito aponta para `https://depix-mvp-production.dev865077.workers.dev/webhooks/eulen/alpha/deposit`.
5. Fazer deploy de production somente a partir do workspace que sera testado.
6. Rodar smoke test de `GET /health` em production.
7. No bot Alpha Production, executar uma compra minima:
   - enviar `/start` ou `/comprar`
   - informar o valor minimo permitido
   - enviar a carteira Liquid
   - confirmar no bot
   - pagar o Pix gerado
8. Observar o webhook Eulen receber `under_review` e depois `depix_sent`.
9. Confirmar no D1 que o pedido terminou como `status=paid` e `current_step=completed`.
10. Confirmar que a mensagem final no Telegram foi enviada sem reenviar QR/Pix.
11. Coletar evidencia com:

```bash
node scripts/collect-qr-flow-evidence.mjs --env production --tenant alpha --order-id <ORDER_ID> --deposit-entry-id <DEPOSIT_ENTRY_ID> --require-split-proof
```

12. Registrar o artefato final em `artifacts/release-0.1/` e referenciar a issue da prova.

### Evidencia aprovada

- Prova atual pos payment-boundary: `#688`, artefato `artifacts/release-0.1/live-alpha-production-20260423T220428Z.json`, resultado `passed`.
- Prova historica anterior: `#634`, artefato `artifacts/release-0.1/live-alpha-production-20260423T101726Z.json`, resultado `passed`.

### Recuperacao quando webhook nao confirmar

O caminho operacional preferido e o recheck manual por `depositEntryId`:

```bash
curl -X POST "$BASE_URL/ops/alpha/recheck/deposit" \
  -H "Authorization: Bearer $OPS_ROUTE_BEARER_TOKEN" \
  -H "content-type: application/json" \
  -d '{ "depositEntryId": "<DEPOSIT_ENTRY_ID>" }'
```

Nao use o fallback por listagem `/deposits` como caminho primario da 0.1. Ele ainda existe no `main`, mas esta marcado para remocao em `#585`, junto com o cron de reconciliacao agendada.
