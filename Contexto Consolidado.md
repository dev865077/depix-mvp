# Contexto Consolidado

Este arquivo resume, em baixa entropia, a versao atual do sistema descrita nos documentos do Obsidian. Ele existe para reduzir consumo de tokens nas proximas sessoes sem perder as decisoes estruturais do projeto.

## Escopo atual

- O produto do MVP foi reduzido para `DePix` como foco principal.
- O sistema roda em `1 Cloudflare Worker` com `1 D1` compartilhado.
- O projeto agora e `multi-tenant`: `2 bots ou mais` podem compartilhar o mesmo Worker, cada um com seu proprio `tenantId`, configuracao e credenciais da Eulen.
- Cada parceiro pode ter catalogo e configuracao proprios, mas a base de codigo continua unica.

## Stack travada

- `Cloudflare Worker`
- `Hono`
- `grammY` para Telegram
- `XState` para fluxo conversacional e estado do pedido
- `D1` com SQL cru
- `Vitest` com ambiente de Workers
- `MSW` para mocks de integracoes externas

## Regras arquiteturais importantes

- `tenantId` e obrigatorio como fronteira logica do sistema.
- `env.DB.batch()` deve ser usado nas escritas criticas que envolvem mais de uma operacao ligada ao mesmo fluxo.
- `Webhook de deposito da Eulen` e a confirmacao principal.
- `deposit-status` e `deposits` sao fallback de reconciliacao e suporte, nao o caminho principal.
- `Split` e obrigatorio em toda cobranca.
- IDs canonicos do dominio:
  - `tenantId`
  - `orderId`
  - `nonce`
  - `depositEntryId` = `response.id` da Eulen
  - `qrId`

## Fluxo do MVP

1. O usuario inicia pelo Telegram.
2. O bot coleta os dados do pedido e gera um `orderId`.
3. O sistema cria a cobranca na Eulen com `nonce` e `split`.
4. O QR e salvo junto ao deposito.
5. O webhook da Eulen confirma o pagamento.
6. O sistema registra evento, atualiza deposito e pedido e segue o fluxo.
7. Se o webhook falhar ou atrasar, entra a reconciliacao por `deposit-status` ou `deposits`.

## Modelo de dados minimo

- `orders`
  - representa a intencao e o estado do pedido
- `deposits`
  - representa a cobranca/entrada gerada na Eulen
- `deposit_events`
  - trilha de callbacks e consultas de reconciliacao

Todas precisam de isolamento por `tenant_id`.

## Governanca de codigo

- Nao fazer push direto em `main`.
- Trabalhar em branch.
- Abrir PR.
- Fazer squash merge.
- Sempre atualizar documentacao no mesmo PR quando mudar:
  - arquitetura
  - schema
  - contratos
  - fluxo operacional

## Estado real do codigo nesta sessao

- A fundacao multi-tenant do Worker foi introduzida no codigo.
- O roteamento por tenant ja existe no path.
- O client da Eulen ja foi preparado para credenciais por tenant.
- O banco ja recebeu `tenant_id` nas tabelas centrais.
- O fluxo funcional completo de `grammY`, `XState` e webhooks reais ainda nao esta implementado por completo.

## Fontes originais lidas

- [Contexto.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Contexto.md>)
- [Faturamento Automações.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Faturamento Automações.md>)
- [Arquitetura Tecnica do MVP.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Arquitetura Tecnica do MVP.md>)
- [Backlog Scrum do MVP.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Backlog Scrum do MVP.md>)
- [KANBAN.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/KANBAN.md>)
- [Mapa de Uso da API.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Mapa de Uso da API.md>)
- [Pix2DePix API - Documentacao Completa.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Docs/Pix2DePix API - Documentacao Completa.md>)
- [Contribuicao e PRs.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Contribuicao e PRs.md>)
- [Open-Source para Reduzir Complexidade no MVP.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Open-Source para Reduzir Complexidade no MVP.md>)
