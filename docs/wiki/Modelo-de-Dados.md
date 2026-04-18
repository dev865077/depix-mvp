# Modelo de Dados

## Tabelas operacionais atuais

### `orders`

- `order_id`
- `user_id`
- `channel`
- `product_type`
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

## Regras de consistencia

- `orders`, `deposits` e `deposit_events` formam um agregado operacional
- escritas criticas multi-tabela devem usar `env.DB.batch()`
- transicoes de `orders.current_step` devem usar guarda condicional de passo quando vierem da maquina XState
- `nonce` representa a intencao da cobranca e deve ser reutilizado em retry controlado
- `depositEntryId` ancora a cobranca local desde o `POST /deposit`
- `qrId` ancora webhook e reconciliacao externa quando ficar disponivel

## Guardas de transicao

Atualizacoes vindas da maquina de pedidos devem usar `tenant_id`, `order_id` e
`current_step` no `WHERE`. Isso evita stale writes: se outro request ja avancou
o pedido, a segunda escrita nao altera a linha e a aplicacao pode observar o
conflito.

O helper `updateOrderByIdWithStepGuard()` separa explicitamente:

- `reason: "updated"` quando a transicao foi gravada
- `reason: "step_conflict"` quando o pedido existe, mas ja saiu do passo esperado
- `reason: "not_found"` quando o pedido nao existe

## Diferenca importante

O modelo canonico do projeto distingue dois IDs externos:

- `depositEntryId`: `response.id` retornado pela Eulen no `POST /deposit`
- `qrId`: identificador do QR/deposito usado em webhook, `deposit-status` e `deposits`

O banco local persiste os dois papeis separadamente. `depositEntryId` nasce na criacao da cobranca; `qrId` pode ser hidratado depois via `deposit-status` ou pelo proprio webhook.

Na migracao do schema legado, o valor antigo de `deposit_id` e copiado para `deposit_entry_id` e `qr_id` para manter linhas historicas acessiveis imediatamente. Depois disso, a reconciliacao pode substituir `qr_id` quando a Eulen expuser um valor canonico diferente.
