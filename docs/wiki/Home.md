# DePix MVP Wiki 2.0

Camada institucional e navegavel da documentacao do `depix-mvp`.

## O que este sistema e

O `depix-mvp` e um bot Telegram multi-tenant para parceiros venderem o fluxo `DePix` usando um unico `Cloudflare Worker` e um unico `D1`, com isolamento logico por `tenantId`.

## Estado atual em uma leitura

- `Hono` ja e a borda HTTP real do Worker
- a fundacao multi-tenant ja existe no `main`
- o runtime Telegram ja foi bootstrapado em `grammY`
- `D1` ja guarda `orders`, `deposits` e `deposit_events`
- webhook real da Eulen, recheck real e fluxo completo do bot ainda nao estao implementados
- `XState` esta travado na arquitetura, mas ainda nao entrou no `main`

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
