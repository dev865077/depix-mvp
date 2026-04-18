# DePix MVP

`depix-mvp` e o MVP de um bot Telegram multi-tenant para fluxo `DePix`, rodando em um unico `Cloudflare Worker`.

## Estado atual

- runtime unico em `Cloudflare Workers`
- borda HTTP em `Hono`
- persistencia em `Cloudflare D1`
- isolamento logico por `tenantId`
- integracao com a API da Eulen
- base multi-tenant ja existe no `main`
- webhook real do Telegram, webhook real da Eulen e recheck operacional ainda estao em fase posterior
- `XState` ja esta travado na arquitetura, mas ainda nao entrou no codigo do `main`
- `production` usa `Cloudflare Secrets Store` para os segredos por tenant; `local` continua em `.dev.vars`

## Comece por aqui

- Wiki institucional: [GitHub Wiki](https://github.com/dev865077/depix-mvp/wiki)
- Documentacao tecnica do repo: [docs/README.md](./docs/README.md)
- Runbook de segredos operacionais: [docs/Cloudflare Secrets Store - Runbook.md](./docs/Cloudflare%20Secrets%20Store%20-%20Runbook.md)
- Contexto consolidado historico: [Contexto Consolidado.md](./Contexto%20Consolidado.md)

## Estrutura principal

- `src/`: app, rotas, runtime, config e integracoes
- `test/`: testes automatizados
- `migrations/`: schema e evolucao do D1
- `docs/`: documentacao tecnica canonicamente versionada
- `.github/workflows/`: CI e automacoes

## Comandos principais

```bash
npm install
npm run dev
npm test
npm run cf:types
npm run db:migrate:local
npm run deploy:test
npm run deploy:production
```

## Regra de documentacao

- a Wiki e a camada institucional e navegavel
- `docs/` e a pasta canonica para documentacao tecnica versionada
- markdowns na raiz passam a ser tratados como material historico ou de transicao
- novas docs nao devem ser criadas na raiz por padrao
- quando codigo, schema, integracao ou operacao mudarem, a documentacao tecnica deve mudar na mesma PR
