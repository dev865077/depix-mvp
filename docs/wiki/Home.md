# DePix MVP Wiki 2.0

Camada institucional e navegavel da documentacao do `depix-mvp`.

## O que este sistema e

O `depix-mvp` e uma plataforma multi-tenant de bot Telegram para o fluxo `DePix`, executada sobre um unico `Cloudflare Worker` e um unico banco `D1`, com isolamento logico por `tenantId`.

## O que este repositorio contem

- um unico runtime em `Cloudflare Workers`
- borda HTTP em `Hono`
- runtime de bot em `grammY`
- persistencia em `D1` para `orders`, `deposits` e `deposit_events`
- integracao com a Eulen para criacao, confirmacao e recheck de depositos
- ambientes de `test` e `production` no Cloudflare
- documentacao tecnica versionada em `docs/`

## Estado atual em uma leitura

- `Hono` ja e a borda HTTP real do Worker
- a fundacao multi-tenant ja existe no `main`
- o webhook do Telegram ja faz despacho real para `grammY`
- o bot Telegram ja tem fluxo inicial para `/start`, texto comum e updates nao suportados
- `D1` ja guarda `orders`, `deposits` e `deposit_events`
- o webhook principal da Eulen ja existe com validacao, idempotencia base e persistencia
- o recheck operacional de deposito ja existe via `POST /ops/:tenantId/recheck/deposit`
- o fallback por janela via `POST /ops/:tenantId/reconcile/deposits` ja reconcilia linhas compactas da Eulen por `qrId`
- a triagem de issues com impacto medio ou alto agora pode abrir uma Discussion de planning review antes da implementacao
- a planning review roda quatro papeis especializados e exige aprovacao unanime para tratar a issue como pronta
- o fluxo funcional completo do bot ainda nao esta concluido
- `XState` ja materializa e persiste o pedido inicial em `draft` no runtime do Telegram, e o bot consegue retomar o pedido aberto do usuario quando ele volta a conversar
- o `/start` agora reaproveita o pedido aberto mais recente e avanca o pedido inicial para `amount` sem duplicar a conversa
- a etapa `amount` agora aceita valores BRL simples no Telegram e avanca o pedido para `wallet` quando o valor e valido
- a etapa `wallet` agora aceita enderecos DePix/Liquid `lq1` e `ex1`, normaliza espacos visuais e avanca o pedido para `confirmation`
- em `confirmation`, respostas como `sim`, `confirmar` e `ok` criam o deposito real na Eulen; `cancelar` encerra o pedido como `canceled`
- o fluxo Telegram agora aceita `/cancel` e comandos equivalentes para cancelar pedidos abertos em `amount`, `wallet` e `confirmation`
- `recomecar` pode cancelar um pedido aberto e reiniciar a conversa com seguranca; sem contexto aberto, nao cria pedido novo por acidente
- replays de mensagens antigas nao sobrescrevem um pedido que ja avancou para `wallet`

## Comece por aqui

1. [Leitura Inicial](Leitura-Inicial)
2. [Visao Geral do Produto](Visao-Geral-do-Produto)
3. [Arquitetura Geral](Arquitetura-Geral)
4. [Estrutura do Repositorio](Estrutura-do-Repositorio)
5. [Ambientes e Segredos](Ambientes-e-Segredos)

## Caminhos por necessidade

### Produto

- [Visao Geral do Produto](Visao-Geral-do-Produto)
- [Escopo e Fluxo](Escopo-e-Fluxo)
- [Roadmap e Backlog](Roadmap-e-Backlog)

### Arquitetura

- [Arquitetura Geral](Arquitetura-Geral)
- [Tenancy e Roteamento](Tenancy-e-Roteamento)
- [Modelo de Dados](Modelo-de-Dados)
- [XState e Fluxo de Pedidos](XState-e-Fluxo-de-Pedidos)
- [Integracoes Externas](Integracoes-Externas)

### Engenharia

- [Estrutura do Repositorio](Estrutura-do-Repositorio)
- [Contribuicao e PRs](Contribuicao-e-PRs)
- [Testes e Qualidade](Testes-e-Qualidade)

### Operacao

- [Ambientes e Segredos](Ambientes-e-Segredos)
- [Deploy e Runbooks](Deploy-e-Runbooks)

### Governanca

- [Governanca Tecnica](Governanca-Tecnica)
- [ADRs](ADRs)

## Fonte de verdade

- Wiki: narrativa institucional, onboarding, mapa do sistema e leitura guiada
- repositorio: implementacao real, configuracao, migrations, testes e contratos versionados
- quando houver divergencia, o repositorio e a fonte de verdade tecnica

## Leitura correta do projeto

O projeto ja tem base tecnica suficiente para desenvolvimento incremental serio, mas ainda nao tem o fluxo funcional completo do MVP no `main`. A leitura correta nao e "sistema pronto"; e "fundacao operacional pronta para evolucao controlada".
