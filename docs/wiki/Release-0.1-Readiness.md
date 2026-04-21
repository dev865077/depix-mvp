# Release 0.1 Readiness

Este documento define o gate operacional minimo para expor a `0.1` ao publico. Ele responde tres perguntas:

- o que precisa estar verde antes do rollout
- quais evidencias provam que o fluxo funcionou
- como operar incidentes sem adivinhar estado financeiro

## Gate curto de release

Bloqueia rollout:

- `GET /health` nao retorna `status=ok` no ambiente alvo
- tenant alvo aparece sem Eulen, secrets ou split configurado
- webhook Telegram aponta para host diferente do host canonico do ambiente
- webhook Eulen nao esta registrado no host canonico do ambiente
- `npm test` ou `npm run typecheck` falha no `main`
- migrations D1 pendentes ou indisponiveis
- compra real pequena nao chega a `orders.status=paid`, `orders.current_step=completed` e `deposits.external_status=depix_sent`
- split proof nao chega a `proved` quando o rollout exige split
- qualquer divergencia nao explicada entre `orders`, `deposits` e `deposit_events`

Pode ficar para `0.2` se houver runbook e aviso operacional:

- dashboard administrativo
- cron automatico em production
- reprocessamento em massa
- multi-produto fora de DePix
- automacao de suporte para todos os casos externos da Eulen

## Matriz minima de validacao

| Cenario | Ambiente | Evidencia obrigatoria | Bloqueia rollout |
| --- | --- | --- | --- |
| Smoke por tenant | `test` e `production` | `/health` com tenant, secrets, split e ops ready | Sim |
| Telegram webhook | `test` e `production` | `/ops/:tenantId/telegram/webhook-info` apontando para host canonico | Sim |
| Criacao de pedido | `test` | transcricao `/start -> valor -> endereco -> confirmacao` | Sim |
| QR e copia-e-cola | `test` | mensagem do QR ou fallback textual com instrucao clara | Sim |
| `/status` | `test` | consulta sem criar novo pedido e sem reabrir terminal | Sim |
| Pagamento real pequeno | `test` | issue #124 ou evidencia equivalente ate `completed` | Sim |
| Pagamento real controlado | `production` | issue #125 ou evidencia equivalente ate `completed` | Sim |
| Webhook Eulen normal | `test` ou `production` | `deposit_events.source=webhook` com `bank_tx_id` e `blockchain_tx_id` quando enviados | Sim |
| Recheck por deposito | `test` ou incidente production | `deposit_events.source=recheck_deposit_status` e agregado consistente | Sim, se webhook falhar |
| Fallback por lista | `test` ou incidente production | `deposit_events.source=recheck_deposits_list` e janela curta documentada | Sim, se recheck nao bastar |
| QR expirado | `test` | `deposits.external_status=expired` e pedido terminal seguro | Sim |
| Notificacao Telegram | `test` e evidencia real | log `telegram.payment_notification.sent` ou skip/failed explicado | Sim |
| Split | `production` | `scripts/collect-qr-flow-evidence.mjs --require-split-proof` com `splitProof.status=proved` | Sim |

Comando canonico de evidencia:

```bash
node scripts/collect-qr-flow-evidence.mjs \
  --env production \
  --tenant alpha \
  --order-id <ORDER_ID> \
  --deposit-entry-id <DEPOSIT_ENTRY_ID> \
  --require-split-proof
```

## Linha do tempo minima por pedido

Para cada pedido real, a evidencia deve conseguir reconstruir:

- `requestId` de health/preflight
- tenant e host canonico usados
- `telegram_chat_id` redigido quando necessario
- `order_id`
- `deposit_entry_id`
- `qr_id`
- `bank_tx_id`
- `blockchain_tx_id`
- `orders.status`
- `orders.current_step`
- `deposits.external_status`
- `deposit_events.source`
- resposta visivel no Telegram

Se algum identificador faltar, a issue de validacao deve dizer explicitamente se o upstream nao enviou o dado ou se o runtime perdeu rastreabilidade.

## Logs e eventos esperados

| Etapa | Evento/log esperado | Contexto minimo |
| --- | --- | --- |
| Entrada HTTP | `request.received` | `tenantId`, `requestId`, `method`, `path` |
| Saida HTTP | `request.completed` | `tenantId`, `requestId`, `status`, `durationMs` |
| Falha HTTP | `request.failed` | `requestId`, erro controlado |
| Telegram ignorado | `telegram.webhook.ignored` | `tenantId`, `requestId`, motivo |
| Telegram dispatch | `telegram.webhook.dispatching` / `telegram.webhook.dispatched` | `tenantId`, `requestId` |
| Telegram erro | `telegram.webhook.failed` | `tenantId`, `requestId`, `code` |
| Confirmacao Eulen | `webhook.eulen.processed` | `tenantId`, `requestId`, `depositEntryId`, `qrId`, `externalStatus` |
| Webhook duplicado | `webhook.eulen.duplicate_ignored` / `webhook.eulen.duplicate_repaired` | `tenantId`, `depositEntryId`, `eventId` |
| Webhook rejeitado | `webhook.eulen.secret_rejected` | `tenantId`, `requestId`, motivo |
| Recheck | `ops.deposit_recheck.processed` | `tenantId`, `depositEntryId`, `orderId`, `qrId`, `externalStatus` |
| Fallback por lista | `ops.deposits_fallback.processed` | `tenantId`, janela, contadores |
| Notificacao enviada | `telegram.payment_notification.sent` | `tenantId`, `orderId`, `depositEntryId` |
| Notificacao skip/falha | `telegram.payment_notification.skipped` / `telegram.payment_notification.failed` | `tenantId`, `orderId`, motivo ou `code` |
| Cron test | `ops.scheduled_deposit_reconciliation.*` | `tenantId`, `scheduledTime`, contadores |

## Catalogo de erros que bloqueiam rollout

| Codigo ou sinal | Significado | Acao |
| --- | --- | --- |
| `invalid_tenant_registry` | `TENANT_REGISTRY` invalido | abortar rollout e corrigir config |
| `ops_route_disabled` | recheck indisponivel | abortar se recovery for necessario |
| `ops_authorization_required` | chamada `/ops` sem bearer | corrigir operador/comando |
| `ops_authorization_invalid` | bearer errado | parar tentativa e revisar segredo |
| `telegram_invalid_payload` | Telegram enviou payload invalido ou contrato que o runtime rejeitou | abrir issue se reproduzivel |
| `webhook_dependency_unavailable` | segredo/token Eulen ausente para webhook | abortar rollout |
| `invalid_webhook_secret` | Eulen esta chamando com secret errado | registrar webhook novamente com o secret correto |
| `tenant_mismatch` | `partnerId` nao bate com tenant | abortar e revisar registry/Eulen |
| `deposit_not_found` | webhook/recheck nao encontrou deposito local | verificar `qrId`, `depositEntryId` e janela de criacao |
| `deposit_qr_id_conflict` | `qrId` remoto pertence a outro deposito | abortar e investigar integridade |
| `deposit_qr_id_mismatch` | Eulen divergiu do `qrId` ja correlacionado | abortar e abrir suporte |
| `deposit_status_regression` | Eulen tentou regredir agregado terminal | nao mutar; abrir incidente |
| `deposit_status_invalid_response` | Eulen respondeu sem `status` utilizavel | abrir suporte se persistir |
| `deposit_status_unavailable` | `deposit-status` falhou | tentar fallback por lista; se falhar, suporte |
| `deposits_fallback_processed` com falhas | fallback processou parcialmente | revisar cada linha antes de concluir rollout |
| `telegram_notification_failed` | usuario pode nao ter recebido conclusao | estado financeiro pode estar ok, mas rollout publico exige mitigacao |
| `splitProof.status != proved` | split nao comprovado | bloquear release com split obrigatorio |

## Runbook de incidentes

### Webhook Eulen ausente ou host errado

Sinais:

- Eulen informa erro de POST para host que nao e canonico
- `deposit_events` nao tem `source=webhook`
- `deposits.external_status` fica `pending` apos pagamento confirmado fora do app

Acao:

1. confirmar host canonico: `https://depix-mvp-production.dev865077.workers.dev/webhooks/eulen/<tenantId>/deposit`
2. validar endpoint com secret correto e payload de probe sem mutar deposito real
3. registrar o webhook correto na Eulen pelo comando oficial `/registerwebhook deposit <url> <secret>`
4. se o pagamento ja ocorreu, reconciliar o deposito especifico por `POST /ops/:tenantId/recheck/deposit`
5. coletar evidencia com `--require-split-proof` se o pagamento tinha split

### Status divergente entre `orders` e `deposits`

Sinais:

- `deposits.external_status=depix_sent`
- `orders.status` ainda `pending`
- `orders.current_step` ainda `awaiting_payment`

Acao:

1. verificar `deposit_events` do `depositEntryId`
2. se houver evento financeiro terminal, reprocessar pelo webhook idempotente ou recheck especifico
3. confirmar que `orders.status=paid` e `orders.current_step=completed`
4. abrir bug se o reparo depender de mutacao manual

### QR expirado

Sinais:

- Eulen retorna `expired`
- usuario tenta pagar depois da expiracao
- `/status` mostra pedido terminal ou sem pagamento

Acao:

1. nao reabrir o mesmo pedido terminal
2. orientar usuario a iniciar novo pedido com `/start` ou `recomecar`
3. validar que o pedido expirado nao aceita novas mutacoes de valor/endereco

### Duplicidade ou replay

Sinais:

- webhook repetido
- Telegram reenvia update antigo
- usuario manda `ok` mais de uma vez na confirmacao

Acao:

1. confirmar que existe no maximo um deposito por `tenant_id + order_id`
2. confirmar que `deposit_events` nao duplicou evento identico
3. confirmar que notificacao Telegram nao duplicou mensagem de confirmacao
4. se houver divergencia, abrir bug com `orderId`, `depositEntryId`, `requestId`

### Erro upstream Eulen

Sinais:

- criacao de deposito falha
- `deposit-status` indisponivel
- contrato invalido da Eulen

Acao:

1. nao criar deposito novo automaticamente para o mesmo pedido
2. marcar pedido com falha segura quando a criacao inicial falhar
3. usar recheck apenas para deposito ja criado
4. abrir suporte com Eulen se o contrato externo vier invalido ou sem campos obrigatorios

### Notificacao Telegram ausente

Sinais:

- estado financeiro esta terminal, mas usuario nao recebeu mensagem
- log `telegram.payment_notification.failed`

Acao:

1. confirmar `orders.telegram_chat_id`
2. confirmar se a transicao ja tinha sido notificada
3. se o envio falhou por erro transitorio, registrar incidente e orientar operador a consultar `/status`
4. nao reprocessar pagamento apenas para reenviar mensagem

## Evidencia real de referencia

Compra production validada em 2026-04-21:

- order: `order_4c35a393-ab0e-4c03-ad6d-a9769aad517f`
- deposit/qrId: `019db14657d879988c7f1227012da7fb`
- final: `orders.status=paid`, `orders.current_step=completed`, `deposits.external_status=depix_sent`
- split: `1.00%`
- bank tx: `fitbank_E0000000020260421182148269581909`
- blockchain tx: `0ce5ae924913e65a5d70cb6601aacae27dabbecda1ad277af94fdb12fc19b270`
- matematica: `5.00 - 0.99 - 0.05 = 3.96`
- split proof: `proved`

Essa evidencia fecha o caminho financeiro minimo, mas nao substitui repetir a matriz quando houver mudanca de contrato externo, segredos, tenant, rotas ou persistencia.
