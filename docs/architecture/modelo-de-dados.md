# Modelo de Dados

## Objetivo

Documentar o modelo operacional atual do `main` e registrar as regras de consistencia que guiam a evolucao do schema.

## Tabelas operacionais

### `orders`

Campos principais atuais:

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
- `created_at`
- `updated_at`

### `deposits`

Campos principais atuais:

- `deposit_id`
- `order_id`
- `nonce`
- `qr_copy_paste`
- `qr_image_url`
- `external_status`
- `expiration`
- `tenant_id`
- `created_at`
- `updated_at`

### `deposit_events`

Campos principais atuais:

- `id`
- `order_id`
- `deposit_id`
- `source`
- `external_status`
- `bank_tx_id`
- `blockchain_tx_id`
- `raw_payload`
- `tenant_id`
- `received_at`

## Regras de consistencia

- `orders`, `deposits` e `deposit_events` formam um unico agregado operacional
- writes criticos multi-tabela devem usar `env.DB.batch()`
- o risco central do sistema e inconsistencia entre essas tres tabelas
- `nonce` representa a intencao da cobranca e deve ser reutilizado em retry

## Diferenca entre schema atual e modelo canonico

No `main`, o schema ainda usa `deposit_id` como identificador principal da cobranca. A direcao canonica do projeto distingue:

- `depositEntryId`: retorno do `POST /deposit`
- `qrId`: identificador que pode chegar depois

Esse alinhamento ainda esta em backlog tecnico e nao deve ser apagado da leitura arquitetural.
