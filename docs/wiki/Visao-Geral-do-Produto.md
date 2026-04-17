# Visao Geral do Produto

## Objetivo

O `depix-mvp` e um bot Telegram multi-tenant para parceiros operarem o fluxo `DePix` sem precisar de um runtime separado por parceiro.

## O que o sistema faz

- recebe o usuario no bot do parceiro
- conduz a conversa
- cria um pedido interno
- gera a cobranca na Eulen
- entrega QR ao usuario
- confirma pagamento via webhook

## Modelo do MVP

- um bot Telegram por parceiro
- um unico `Cloudflare Worker` para todos os parceiros
- um unico banco `D1`
- isolamento logico por `tenantId`
- configuracao e credenciais por parceiro

## Regras travadas

- o MVP cobre apenas `DePix`
- split e obrigatorio em toda cobranca
- webhook da Eulen e confirmacao primaria
- `deposit-status` e `deposits` sao fallback
- sem microservicos, fila central e painel interno no MVP

## O que nao e o produto nesta fase

- nao e uma plataforma multi-servico
- nao e um painel administrativo
- nao e um sistema de entrega externa completo para `BTC` e `USDT`
- nao e uma arquitetura distribuida

## Leitura correta do estado atual

O desenho do produto esta mais maduro do que a implementacao final do fluxo. O `main` ja sustenta a base tecnica e os contratos principais, mas ainda nao materializa toda a jornada funcional do bot.
