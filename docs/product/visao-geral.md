# Visao Geral do Produto

## Objetivo

O `depix-mvp` e um bot Telegram multi-tenant para parceiros venderem o fluxo DePix sem precisar de um runtime por parceiro.

## O que o sistema faz

- recebe o usuario no bot do parceiro
- conduz a conversa de compra
- cria um pedido interno
- gera uma cobranca Pix na Eulen
- entrega QR ao usuario
- confirma pagamento via webhook

## Modelo de negocio do MVP

- um bot Telegram por parceiro
- um unico Worker para todos os parceiros
- um unico banco `D1`
- isolamento logico por `tenantId`
- catalogo, configuracao e conta Eulen por parceiro

## Regras travadas

- o MVP cobre apenas `DePix`
- split e obrigatorio em toda cobranca
- webhook de deposito da Eulen e a confirmacao primaria
- `deposit-status` e `deposits` sao fallback
- nao ha microservicos, fila nem painel interno no MVP

## Status internos relevantes

- `pending`
- `depix_sent`
- `under_review`
- `error`
- `expired`
- `canceled`
- `refunded`

## Estado atual do codigo

No `main`, a base do Worker, do roteamento multi-tenant, do `D1` e do runtime Telegram bootstrapado ja existe. O fluxo completo de conversa, cobranca e confirmacao ainda nao esta fechado no codigo.
