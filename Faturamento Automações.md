# Faturamento e Automacoes do MVP

> [!tip]
> Documento mestre: [[Misc/DePix/Contexto|Contexto]]
>
> Arquitetura: [[Misc/DePix/Arquitetura Tecnica do MVP|Arquitetura Tecnica do MVP]]
>
> Backlog: [[Misc/DePix/Backlog Scrum do MVP|Backlog Scrum do MVP]]

## Objetivo

Definir como o MVP usa a API da Eulen/DePix no fluxo real de venda, cobranca e confirmacao.

## Decisoes travadas do MVP

- a API da Eulen entra como camada de cobranca e confirmacao
- split faz parte obrigatoria do `deposit`
- `DePix` pode ser concluido dentro do fluxo da API
- `BTC` e `USDT` ficam com entrega final fora da API da Eulen
- o MVP sera implementado com `Hono`, `grammY`, `XState` e `Cloudflare D1` nativo com SQL cru

## Fluxo tecnico do MVP

```mermaid
flowchart LR
    U["Usuario"] --> T["Telegram"]
    T --> G["grammY"]
    G --> H["Hono / Cloudflare Worker"]
    H --> DB["D1 nativo + SQL cru"]
    H --> E["Cliente Eulen"]
    E --> API["Eulen API"]
    API -->|qrCopyPaste + qrImageUrl| H
    H --> G
    API -->|deposit webhook| H
    H --> DB
    H --> X["Entrega externa de BTC/USDT"]
```

## Stack usada no fluxo

| Camada | Escolha | Papel no MVP |
|---|---|---|
| HTTP e webhooks | `Hono` | rotas, middleware e borda do Worker |
| Telegram | `grammY` | webhook do bot, comandos e conversa |
| Estados | `XState` | conversa guiada e transicoes do pedido |
| Persistencia | `Cloudflare D1` + SQL cru via API nativa | pedido, cobranca, eventos e estado da conversa |
| Testes | `Vitest` + `Cloudflare Workers` + `MSW` | unitario, integracao, webhook e fluxo critico |

## O que usamos da API no MVP

- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#🔑 Authentication|Authentication]] para token
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#Ping|Ping]] para validar ambiente
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#Deposit (PIX ➔ DePix)|Deposit (PIX ➔ DePix)]] para criar a cobranca
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#DepositRequest|DepositRequest]] para o request
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#🪝 Webhook|Webhook]] para confirmacao principal
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#Deposit Status|Deposit Status]] para fallback por deposito
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#Deposits|Deposits]] para fallback por janela
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#🎲 Nonce|Nonce]] para idempotencia
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#🔄 Sync / Async call|Sync / Async call]] para retry controlado

## Request real do `deposit` no MVP

| Campo | Origem | Uso |
|---|---|---|
| `amountInCents` | valor escolhido pelo usuario | cria a cobranca |
| `depixSplitAddress` | configuracao interna | direciona o split |
| `splitFee` | configuracao interna | define o split |
| `depixAddress` | carteira do usuario | so quando o produto for `DePix` |
| `X-Nonce` | sistema | idempotencia por intencao |
| `X-Async` | sistema | modo `auto` do fluxo |

> [!warning]
> `depixSplitAddress` e `splitFee` nunca devem vir do usuario final. Eles entram por configuracao interna do projeto.

## Fluxo de negocio

1. O usuario inicia o fluxo no Telegram.
2. `XState` dirige a conversa e o bot coleta ativo, valor e carteira.
3. O sistema cria ou atualiza um pedido em `draft`.
4. O sistema chama `deposit` com split.
5. O usuario recebe `qrCopyPaste` e `qrImageUrl`.
6. A Eulen confirma o pagamento via webhook.
7. O sistema atualiza o pedido e decide a saida final.

> [!note]
> O webhook principal de deposito agora faz validacao do segredo no header `Authorization`, persiste o callback em `deposit_events` e aplica o status externo em `deposits` e `orders`. O fallback por `deposit-status` e `deposits` continua como etapa separada.

## Status que importam

| Status externo | Tratamento interno |
|---|---|
| `pending` | aguardando pagamento |
| `depix_sent` | pagamento confirmado |
| `under_review` | fila manual |
| `error` | fila manual |
| `expired` | encerrar como expirado |
| `canceled` | encerrar como cancelado |
| `refunded` | encerrar como reembolsado |

> [!note]
> Para `DePix`, `depix_sent` pode encerrar o pedido. Para `BTC` e `USDT`, `depix_sent` confirma o faturamento e libera a entrega externa.

## Fallback

- usar [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#Deposit Status|Deposit Status]] para um deposito especifico
- usar [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#Deposits|Deposits]] para reconciliar por janela
- manter webhook como caminho principal; fallback entra so quando houver falha ou duvida

## Fora do MVP

- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#Pix2FA|Pix2FA]]
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#💬 Pix Messaging|Pix Messaging]]
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#⏱️ QR Delay|QR Delay]]
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#User Info|User Info]]
- [[Misc/DePix/Docs/Pix2DePix API - Documentacao Completa#Withdraw|Withdraw]]
- fila dedicada
- painel interno
