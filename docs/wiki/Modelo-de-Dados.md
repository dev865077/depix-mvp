# Modelo de Dados

## Tabelas operacionais atuais

### `orders`

- `order_id`
- `user_id`
- `channel`
- `product_type`
- `telegram_chat_id`
- `amount_in_cents`
- `wallet_address`
- `current_step`
- `status`
- `split_address`
- `split_fee`
- `tenant_id`

### `deposits`

- `deposit_entry_id`
- `qr_id`
- `order_id`
- `nonce`
- `qr_copy_paste`
- `qr_image_url`
- `external_status`
- `expiration`
- `tenant_id`

### `deposit_events`

- `id`
- `order_id`
- `deposit_entry_id`
- `qr_id`
- `source`
- `external_status`
- `bank_tx_id`
- `blockchain_tx_id`
- `raw_payload`
- `tenant_id`

### Modelos de persistencia em TypeScript

Os contratos usados pelos repositories de D1 foram explicitados em `src/types/persistence.ts`.

- `OrderRecord` e `CreateOrderInput` cobrem leitura e escrita da tabela `orders`
- `DepositRecord` e `CreateDepositInput` cobrem leitura e escrita da tabela `deposits`
- `DepositEventRecord` e `CreateDepositEventInput` cobrem leitura e escrita da tabela `deposit_events`
- `OrderPatch` e `DepositPatch` definem os patches permitidos nas atualizacoes parciais
- `HydrateOrderTelegramChatResult` e `UpdateOrderWithStepGuardResult` explicita os resultados estruturados usados pelo fluxo de pedidos

### `deposit_order_duplicate_quarantine`

- guarda linhas historicas retiradas de `deposits` quando uma migration encontra mais de um deposito para o mesmo `tenant_id + order_id`
- preserva `canonical_deposit_entry_id` para apontar qual deposito continuou ativo no agregado principal
- existe para auditoria e recuperacao operacional; o runtime do usuario nao deve ler essa tabela como fonte de QR ativo

### `deposit_order_duplicate_event_quarantine`

- guarda eventos associados aos depositos movidos para quarentena
- preserva `original_event_id`, payload bruto e `canonical_deposit_entry_id`
- permite investigar duplicidade historica sem manter dois depositos ativos no mesmo pedido

## Regras de consistencia

- `orders`, `deposits` e `deposit_events` formam um agregado operacional
- escritas criticas multi-tabela devem usar `env.DB.batch()`
- transicoes de `orders.current_step` devem usar guarda condicional de passo quando vierem da maquina XState
- `nonce` representa a intencao da cobranca e deve ser reutilizado em retry controlado
- `depositEntryId` ancora a cobranca local desde o `POST /deposit`
- `qrId` ancora webhook e reconciliacao externa quando ficar disponivel
- cada par `tenant_id + order_id` pode ter no maximo um registro em `deposits`; esta e a invariavel financeira do MVP enquanto nao houver refund, chargeback, split em varias cobrancas ou recriacao explicita de cobranca dentro do mesmo pedido
- retry de confirmacao deve reutilizar o deposito local existente do pedido em vez de chamar a Eulen novamente
- a transicao `confirmation -> creating_deposit` funciona como lease do side effect externo: apenas o request que grava essa transicao pode chamar `POST /deposit`; concorrentes devem observar conflito de passo antes da Eulen
- um deposito local reutilizado precisa ter `depositEntryId`, `qrCopyPaste` e `qrImageUrl`; se uma linha historica estiver malformada, o pedido falha fechado e exige operacao manual, sem criar nova cobranca externa
- se a migration de unicidade encontrar duplicados historicos, apenas o deposito canonico permanece em `deposits`; os demais vao para quarentena auditavel antes da criacao do indice unico
- a escolha canonica de duplicados historicos prioriza `depix_sent`, depois `pending_pix2fa`, depois `pending`, depois `expired`, e por fim o registro mais recente
- o runtime do Telegram pode buscar o pedido aberto mais recente por `tenant_id`, `user_id` e `channel` para retomar a conversa sem duplicar contexto
- `orders.telegram_chat_id` guarda o destino real do chat Telegram para notificacoes assincronas futuras; ele nao deve ser inferido a partir de `user_id`
- a escrita de `telegram_chat_id` continua sendo o contrato de persistencia do destino; o envio assincrono pos-pagamento agora usa esse campo quando o estado financeiro confirmar pagamento
- pedidos legados com `telegram_chat_id = NULL` continuam legiveis, mas nao possuem destino assincrono seguro ate serem hidratados por um novo update Telegram do mesmo tenant, usuario e canal
- pedidos legados que nunca receberem novo update Telegram permanecem com `telegram_chat_id = NULL`; qualquer emissor assincrono futuro deve tratar isso como skip controlado e evidencia operacional, nunca como fallback para `user_id`
- a hidratacao de `telegram_chat_id` deve usar o pedido aberto mais recente selecionado por `tenant_id`, `user_id`, `channel`, `updated_at DESC` e `created_at DESC`
- a escrita de `telegram_chat_id` deve ser atomica e usar `tenant_id`, `order_id`, `user_id`, `channel` e `telegram_chat_id IS NULL` no `WHERE`
- se um update chegar com chat diferente do `telegram_chat_id` persistido, o sistema nao deve sobrescrever o destino e deve registrar `telegram.order.chat_divergence_detected`
- updates conversacionais sem `chat.id` nao podem criar, retomar ou reiniciar pedido, porque isso produziria um agregado sem destino seguro para notificacao futura
- `telegram_chat_id = NULL` significa "sem destino assincrono seguro"; a etapa de notificacao nao pode usar `user_id` como fallback implicito
- quando o pedido aberto estiver em `draft`, o comando `/start` avanca o agregado para `amount` sem criar uma nova linha
- quando o pedido estiver em `amount`, o valor BRL recebido no Telegram deve atualizar `amount_in_cents` e avancar o `current_step` para `wallet`
- quando o pedido estiver em `wallet`, o endereco DePix/Liquid recebido no Telegram deve atualizar `wallet_address` e avancar o `current_step` para `confirmation`
- quando o pedido estiver em `confirmation`, a confirmacao do usuario cria o deposito real e grava `deposit_entry_id`
- `cancelar` em `confirmation` encerra o pedido sem criar deposito
- `cancel`, `cancelar` e `recomecar` podem cancelar um pedido aberto em `amount`, `wallet` ou `confirmation`
- `recomecar` deve reaproveitar o contexto aberto quando existir e nao deve criar pedido novo quando nao houver contexto aberto
- buscas de pedido aberto para Telegram devem excluir `completed`, `failed`, `canceled`, `manual_review` e aliases legados terminais como `paid`; esses registros permanecem auditaveis, mas nao sao mais editaveis pelo usuario
- replays de mensagens antigas nao devem sobrescrever `amount_in_cents` quando o pedido ja saiu de `amount`
- replays de mensagens antigas nao devem sobrescrever `wallet_address` quando o pedido ja saiu de `wallet`
- quando um agregado financeiro confirma `depix_sent` / `paid` + `completed`, o envio assincrono de Telegram deve ser tratado como side effect idempotente e nao como dado principal

## Guardas de transicao

Atualizacoes vindas da maquina de pedidos devem usar `tenant_id`, `order_id` e `current_step` no `WHERE`. Isso evita stale writes: se outro request ja avancou o pedido, a segunda escrita nao altera a linha e a aplicacao pode observar o conflito.

O helper `updateOrderByIdWithStepGuard()` separa explicitamente:

- `reason: "updated"` quando a transicao foi gravada
- `reason: "step_conflict"` quando o pedido existe, mas ja saiu do passo esperado
- `reason: "not_found"` quando o pedido nao existe

## Diferenca importante

O modelo canonico do projeto distingue dois IDs externos:

- `depositEntryId`: identificador local da cobranca criada
- `qrId`: identificador externo que pode chegar depois via webhook ou recheck

Esses campos nao devem ser tratados como sinonimos.
