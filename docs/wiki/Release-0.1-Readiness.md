# Release 0.1 Readiness

## Critérios de bloqueio

O rollout fica bloqueado se qualquer um destes pontos nao estiver valido no ambiente alvo:

- gate real Telegram 0.1 com preflight verde e JSON de execucao real controlada
- autenticação e tenancy
- persistência D1 operacional
- webhook da Eulen validado
- fluxo Telegram validado
- tipo e build validos
- estrategia de rollback definida

## Itens que podem ficar para depois

Alguns itens podem ficar para `0.2` se houver runbook e aviso operacional:

- dashboard administrativo
- reprocessamento em massa
- multi-produto fora de DePix
- automacao de suporte para todos os casos externos da Eulen

## Evidencia minima por area

| Area | Ambiente alvo | Evidencia minima | Bloqueia release? |
| --- | --- | --- | --- |
| Gate real Telegram 0.1 | `production` | `artifacts/telegram-real-flow/preflight-*.json` verde + `real-run-*.json` com `status=success` | Sim |
| Pagamento real controlado | `production` | issue #125 ou evidencia equivalente ate `completed` | Sim |
| Webhook Eulen normal | `test` ou `production` | `deposit_events.source=webhook` com `bank_tx_id` e `blockchain_tx_id` quando enviados | Sim |
| Recheck por deposito | `test` ou incidente production | `deposit_events.source=recheck_deposit_status` e agregado consistente | Sim, se webhook falhar |
| Reconciliação agendada | `production` | `/health.operations.scheduledDepositReconciliation.ready=true` e cron `*/15 * * * *` publicado | Sim |
| Fallback por lista | `test` ou incidente production | `deposit_events.source=recheck_deposits_list` e janela curta documentada | Sim, se recheck nao bastar |
| QR expirado | `test` | `deposits.external_status=expired` e pedido terminal seguro | Sim |
| Notificacao Telegram | `test` e evidencia real | log `telegram.payment_notification.sent` ou skip/failed explicado | Sim |

## Regras de aceite

- nao considerar release pronta sem `npm run telegram:preflight` verde no ambiente alvo
- nao considerar release pronta sem `npm run telegram:real-run -- --confirm-real` gerando JSON `status=success`
- o teste real precisa observar `callback_query`, confirmacao por botao, QR/Pix gerado e pagamento confirmado quando `--require-payment-confirmed` for usado
- nao considerar release pronta sem pelo menos um caminho operacional de confirmacao financeira validado
- em caso de incidente, o caminho aceito precisa ser explicito no runbook
- toda mudanca que altere ambiente, segredo, fluxo de pagamento ou webhook precisa atualizar esta pagina na mesma PR

## Leitura correta

Esta pagina nao substitui o runbook nem a documentacao de integracao. Ela so define o que ainda bloqueia o corte de release.
