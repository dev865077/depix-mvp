# Release 0.1 Readiness

Esta pagina define o gate operacional minimo para expor a release `0.1` ao publico.

## Gate de release

O rollout fica bloqueado se qualquer um destes pontos nao estiver valido no ambiente alvo:

- `GET /health` nao retorna `status=ok`
- tenant alvo sem Eulen, secrets ou split configurado
- webhook Telegram apontando para host diferente do host canonico do ambiente
- webhook Eulen nao registrado no host canonico do ambiente
- `npm test` ou `npm run typecheck` falhando no `main`
- migrations D1 pendentes ou indisponiveis
- compra real pequena nao chega aos estados esperados de pedido e deposito
- split proof nao chega a `proved` quando o rollout exige split
- qualquer divergencia nao explicada entre `orders`, `deposits` e `deposit_events`

Alguns itens podem ficar para `0.2` se houver runbook e aviso operacional:

- dashboard administrativo
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
| Reconciliação agendada | `production` | `/health.operations.scheduledDepositReconciliation.ready=true` e cron `*/15 * * * *` publicado | Sim |
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

A evidencia deve permitir reconstruir, para cada pedido real:

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
- timestamp da criacao
- timestamp da confirmacao ou do erro
- timestamp da notificacao Telegram, quando houver

## Logs e eventos esperados

Por etapa, a operacao espera conseguir correlacionar:

- preflight: `GET /health`
- criacao: pedido e deposito persistidos em D1
- webhook: evento de confirmacao da Eulen e atualizacao dos agregados
- recheck: evento auditavel de reconciliacao quando o webhook nao bastar
- fallback: evento auditavel de reconciliacao por janela curta
- notificacao: envio ou skip/failed da mensagem Telegram, com motivo explicito

## Catalogo de erros que bloqueiam rollout

Enquanto estes erros estiverem ocorrendo, o rollout nao deve seguir:

- health fora de `ok`
- webhook canonico ausente ou apontando para host incorreto
- secrets ou bindings obrigatorios ausentes
- divergencia nao explicada entre pedido, deposito e evento
- resposta invalida da Eulen para criacao, webhook ou recheck
- pedido que nao chega ao estado terminal esperado apos pagamento real controlado
- split audit nao comprovado quando exigido
- notificacao Telegram quebrada sem runbook de operacao

## Runbooks de incidente

### Webhook

Se o webhook falhar, confirmar:

1. host canonico correto
2. webhook registrado no tenant correto
3. segredo e autorizacao validos
4. payload recebendo o contrato esperado

Se necessario, usar recheck antes de reprocessar.

### Estado divergente

Se `orders`, `deposits` e `deposit_events` divergirem:

1. identificar o `order_id` e `deposit_entry_id`
2. comparar evento mais recente com o estado persistido
3. usar recheck ou fallback conforme o tipo de lacuna
4. nao adivinhar estado financeiro

### QR expirado

Se o QR expirar antes da confirmacao:

1. marcar a evidencia como terminal
2. confirmar se o pedido permaneceu seguro
3. nao reabrir manualmente o pedido sem trilha

### Duplicados

Se houver duplicidade de confirmacao:

1. tratar como problema de idempotencia
2. checar `deposit_events` e a correlacao do deposito
3. validar se o evento repetido foi apenas reprocessado

### Eulen falhando

Se a Eulen falhar:

1. registrar o erro exato
2. avaliar se recheck resolve
3. se necessario, usar fallback por janela curta
4. manter a evidencia da falha ligada ao pedido

### Notificacao Telegram falhando

Se a notificacao falhar:

1. confirmar se o pagamento foi conciliado
2. validar o `telegram_chat_id`
3. verificar logs de envio ou skip
4. nao confundir falha de notificacao com falha de pagamento

## Regra operacional

A release `0.1` so pode ser exposta quando o gate curto, a matriz minima e as evidencias por pedido estiverem consistentes e documentadas.
