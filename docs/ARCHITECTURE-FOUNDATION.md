# Architecture Foundation

## Objetivo

Este documento descreve a fundacao atual da `S1` no repositorio `depix-mvp`.
Ele existe para que outras IAs e devs entendam rapidamente como a base foi
quebrada antes de entrarmos em Telegram real, Eulen, webhook e reconciliacao.

## Principios

- manter o projeto `100% JavaScript`
- comentar o codigo acima do usual
- separar transporte, conversa, persistencia e observabilidade
- evitar frameworks e servicos extras enquanto o Worker simples resolve
- deixar o planejamento Scrum como fonte de verdade do progresso

## Modulos iniciais

- `src/index.js`
  entrada publica do Worker
- `src/app.js`
  montagem da aplicacao HTTP
- `src/lib/http/`
  respostas JSON e roteamento simples
- `src/lib/telegram/`
  estados e fluxo da conversa do MVP
- `src/lib/data/`
  binding `D1`, schema e repositorios iniciais
- `src/lib/observability/`
  logger estruturado minimo
- `migrations/0001_initial_schema.sql`
  schema inicial versionado para `D1`

## Fronteira atual da Sprint 1

Ja coberto na fundacao:

- modularizacao inicial do Worker
- modelagem dos estados da conversa
- transicoes basicas da jornada `DePix-first`
- schema inicial para pedidos, sessoes e eventos externos
- repositorios base para `D1`

Ainda nao coberto:

- adaptador real do Telegram
- bindings reais de `D1` no ambiente Cloudflare
- secrets carregados no runtime
- client Eulen
- webhook
- cron de reconciliacao

## Decisao de persistencia inicial

`D1` e a base principal de verdade do MVP. A estrutura inicial foi separada em:

- `orders`
  pedido principal e estado comercial
- `telegram_sessions`
  contexto conversacional do chat
- `external_events`
  historico bruto de webhooks, callbacks e reconciliacoes

Essa separacao foi escolhida para manter rastreabilidade sem depender de
memoria de processo e sem introduzir `Durable Objects` antes de haver uma
necessidade real de concorrencia mais dura.

## Proximo encaixe previsto

Quando a `S2` comecar:

1. `Secrets` entram no runtime
2. o client Eulen usa `orders` como ancora
3. `deposit` grava `depositId`, `qrId`, QR e expiracao em `orders`
4. webhook e reconciliacao passam a gravar em `external_events`

## Leitura recomendada

- `docs/IMPLEMENTATION-CONVENTIONS.md`
- `src/lib/telegram/conversation-states.js`
- `src/lib/telegram/flow.js`
- `src/lib/data/schema.js`
