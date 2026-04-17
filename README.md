# DePix MVP

Bot Telegram multi-tenant para venda do fluxo DePix, rodando em um unico Cloudflare Worker com persistencia em D1 e isolamento logico por `tenantId`.

## Estado do repositorio

- runtime unico em `Cloudflare Workers`
- borda HTTP em `Hono`
- bootstrap de runtime Telegram em `grammY`
- persistencia em `D1` com SQL cru
- webhook Telegram real ainda em evolucao
- webhook Eulen e recheck ainda estao como placeholders no `main`

## Leitura rapida

- [Home da documentacao](./docs/README.md)
- [Leitura inicial](./docs/getting-started.md)
- [Visao geral do produto](./docs/product/visao-geral.md)
- [Arquitetura geral](./docs/architecture/arquitetura-geral.md)
- [Estrutura do repositorio](./docs/engineering/estrutura-do-repositorio.md)
- [Ambientes e segredos](./docs/operations/ambientes-e-segredos.md)

## Stack travada do MVP

- `Cloudflare Workers`
- `Hono`
- `grammY`
- `XState`
- `Cloudflare D1`
- `Vitest` + testes de Workers + `MSW`

## Fontes complementares ja existentes no repo

- [Contexto](./Contexto.md)
- [Arquitetura Tecnica do MVP](./Arquitetura%20Tecnica%20do%20MVP.md)
- [Backlog Scrum do MVP](./Backlog%20Scrum%20do%20MVP.md)
- [KANBAN](./KANBAN.md)
- [Cloudflare para o MVP - Free Tier e Arquitetura Simples](./docs/Cloudflare%20para%20o%20MVP%20-%20Free%20Tier%20e%20Arquitetura%20Simples.md)
- [Pix2DePix API - Documentacao Completa](./docs/Pix2DePix%20API%20-%20Documentacao%20Completa.md)
