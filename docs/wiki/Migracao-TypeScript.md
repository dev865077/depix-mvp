# Migracao TypeScript

Esta pagina e o artefato canonico de fechamento da epic #186. Ela consolida o
estado final da migracao TypeScript central do `depix-mvp`, as ondas executadas,
os comandos oficiais, os limites que permanecem em JavaScript e a referencia de
validacao operacional.

## Estado final

- `src/index.ts` e o ponto de entrada canonico do Worker em `package.json` e
  `wrangler.jsonc`
- `tsconfig.json` usa `strict: true`, `noEmit: true` e `allowJs: true`
- `worker-configuration.d.ts` e gerado por `npm run cf:types`
- contratos compartilhados vivem em `src/types/`
- rotas centrais, bootstrap do Worker, client Eulen, webhook Eulen,
  repositories D1, maquina de progresso e borda principal do Telegram ja tem
  contratos TypeScript
- `npm test` usa `scripts/run-vitest-sequential.mjs` para separar specs Node e
  Cloudflare por marcador explicito
- specs `*.test.js` e `*.test.ts` sao descobertas pelo runner canonico
- imports Node de modulos migrados usam `node --import tsx` quando precisam
  carregar entrypoints TypeScript fora do Worker

## Ondas da epic

| Issue | PR | Resultado |
| --- | --- | --- |
| #179 | #238 | Fundacao TypeScript estrita, `typecheck`, tipos do Worker e coexistencia incremental |
| #180 | #247 | Contratos de dominio, tenancy e registry tipados |
| #181 | #249 | Maquina de progresso de pedidos migrada para TypeScript estrito |
| #182 | #251 | Repositories D1 e modelos de persistencia tipados |
| #183 | #261 | Borda Telegram com contrato inbound explicito |
| #203 | #259 | Borda Eulen, webhook e client externo tipados |
| #199 | #257 | Bootstrap HTTP, `Env` e contexto do Worker tipados |
| #184 | #263 | Rotas HTTP centrais migradas para TypeScript |
| #200 | #265 | Helpers HTTP e mapeamento de erro tipados |
| #195 | #267 | Harness Vitest preparado para specs TypeScript e pools separados |
| #196 | #275 | Runtime final em `src/index.ts` e limpeza de duplicatas JS/TS centrais |
| #204 | #277 | Runbook de validacao, gates e rollback tecnico por onda |
| #185 | #279 | Checklist documental final e fechamento da epic |

## Comandos canonicos

```bash
npm run typecheck
npm run cf:types
npm test
npm run dev
npm run db:migrate:local
npx wrangler deploy --dry-run --env test
npx wrangler deploy --dry-run --env production
```

`npm run dev` continua sendo o comando local padrao. Para smoke operacional de
entrypoint, use uma porta explicita e valide `/health`:

```bash
npm run dev -- --local --port 8790
curl -fsS http://127.0.0.1:8790/health
```

## EntryPoints e runtime

- Worker: `src/index.ts`
- App Hono: `src/app.ts`
- Config Cloudflare: `wrangler.jsonc`
- Tipos gerados do Worker: `worker-configuration.d.ts`
- Runner de testes: `scripts/run-vitest-sequential.mjs`
- Config Vitest Node: `vitest.node.config.js`
- Config Vitest Cloudflare: `vitest.config.js`

`src/index.js` nao e mais o bootstrap canonico. Arquivos `.js` que continuam no
repositorio permanecem por limite operacional explicito, nao por duplicacao do
entrypoint central.

## Excecoes JavaScript legitimas

`allowJs` permanece ativo porque a migracao central encerrou as superficies de
maior risco, mas ainda ha arquivos JavaScript com razao pratica para permanecer:

- scripts operacionais e automacoes em `scripts/*.mjs`
- configs e runners esperados pelo ecossistema Node/Vitest/Wrangler
- helpers de teste sem contrato financeiro ou externo relevante
- modulos de servico e Telegram que ainda nao possuem issue dedicada de
  migracao, mas ja rodam cobertos por suites existentes

Lista curta de excecoes de runtime ainda existentes em `src/`:

- `src/lib/background-tasks.js`
- `src/lib/logger.js`
- `src/middleware/request-context.js`
- `src/services/eulen-deposit-recheck.js`
- `src/services/eulen-deposits-fallback.js`
- `src/services/local-diagnostic-validation.js`
- `src/services/order-registration.js`
- `src/services/scheduled-deposit-reconciliation.js`
- `src/services/telegram-order-confirmation.js`
- `src/services/telegram-payment-notifications.js`
- `src/services/telegram-webhook-ops.js`
- `src/telegram/brl-amount.js`
- `src/telegram/diagnostics.js`
- `src/telegram/reply-flow.runtime.js`
- `src/telegram/wallet-address.js`

Qualquer remocao ou migracao futura desses arquivos deve sair em issue propria,
com rollback isolado e suite focada. A epic #186 nao deve ser reaberta apenas
porque essas excecoes existem.

## Validacao e rollback

O contrato operacional fica em
[Validacao e Rollback TypeScript](Validacao-e-Rollback-TypeScript).

Para ondas que alteram bootstrap, deploy, Cloudflare bindings, rotas, webhooks,
persistencia ou runner de testes, `npm test` sozinho nao basta. Use a matriz de
#204 para decidir quais smokes e dry-runs entram como evidencia obrigatoria.

Rollback minimo continua sendo reverter a PR isolada da onda que introduziu a
regressao. Nao aplicar hotfix amplo antes de verificar se o revert da onda
resolve a superficie quebrada.

## Checklist de encerramento

- [x] `tsconfig.json` existe com `strict: true`
- [x] `src/types/` concentra contratos compartilhados
- [x] `src/index.ts` e o entrypoint canonico
- [x] rotas HTTP centrais foram migradas para TypeScript
- [x] Telegram e Eulen possuem contratos de borda explicitados
- [x] D1 repositories usam modelos de persistencia tipados
- [x] Vitest descobre specs JavaScript e TypeScript
- [x] comandos `typecheck`, `cf:types`, `npm test` e `npm run dev` sao canonicos
- [x] runbook de validacao/rollback existe em #204
- [x] excecoes JavaScript restantes estao documentadas aqui

## Manutencao

Quando uma PR futura mudar entrypoint, comandos canonicos, runner de testes,
contratos de runtime ou lista de excecoes JavaScript, esta pagina deve ser
atualizada na mesma PR.
