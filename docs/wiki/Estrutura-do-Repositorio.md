# Estrutura do Repositorio

## Arvore principal

```text
src/
test/
migrations/
docs/
.github/workflows/
```

## Ownership no modelo de tres repositorios

Enquanto o split nao termina, `depix-mvp` continua carregando todos os
diretorios abaixo. Depois do cutover do track `#674`, a leitura de ownership
fica assim:

| Repositorio alvo | Area atual usada como fonte | Responsabilidade |
| --- | --- | --- |
| `debot` | `src/telegram/`, partes bot-facing de `src/routes/telegram.ts`, testes Telegram e docs de UX | Conversa Telegram, comandos, callbacks, copy, retomada de pedido e chamadas bot -> API |
| `api` | `src/routes/webhooks.ts`, `src/routes/ops.ts`, `src/clients/eulen-client.ts`, `src/db/`, `migrations/`, config financeira e runbooks operacionais | Eulen, D1 financeiro, webhooks, recheck, WAF, persistencia e rotas ops financeiras |
| `github-automation` | `.github/workflows/`, `.github/prompts/`, scripts `ai-*` e testes de automacao | Triage, planning, refinement, PR review, wiki update e governanca automatizada |

Setup local tambem deve seguir esse ownership: alteracoes de bot devem preparar
secrets Telegram e token interno da API; alteracoes financeiras devem preparar
D1/KV, Eulen e ops token; alteracoes de automacao devem preparar GitHub token,
OpenAI e variaveis de modelo.

## Leitura por area

### `src/app.ts`

Composicao do `Hono`, middleware, tratamento global de erro e montagem das rotas.

### `src/index.ts`

Ponto de entrada canonico do Worker. Permanece importavel como bootstrap principal do runtime.
Tambem e o valor canonico de `main` em `package.json` e `wrangler.jsonc`.

### `src/routes/`

Borda HTTP canonica:

- `health.ts`
- `telegram.ts`
- `webhooks.ts`
- `ops.ts`

As rotas centrais ja foram migradas para TypeScript, junto com o glue de autorizacao operacional usado em `ops`.

### `src/config/`

Runtime, tenants e resolucao de bindings.

### `src/types/`

Contratos de dominio, persistencia e boundary de runtime compartilhados entre o parser de tenancy e as areas que consomem o registry.

### `src/order-flow/`

Maquina de progresso de pedidos e constantes de dominio do fluxo inicial. O contrato autoritativo da maquina agora e TypeScript estrito.

### `src/telegram/`

Bootstrap, cache do runtime Telegram, parsing de update inbound, erros publicos e reply flow. A borda principal esta tipada; helpers de dominio ainda podem permanecer em JavaScript quando listados como excecao legitima em [Migracao TypeScript](Migracao-TypeScript).

### `src/db/`

Client do `D1` e repositories operacionais. O boundary do banco usa helpers tipados e modelos de persistencia explicitos para `orders`, `deposits` e `deposit_events`.

### `src/clients/`

Integracoes HTTP externas. O client Eulen canonico esta em TypeScript.

### `migrations/`

Schema inicial e evolucao multi-tenant.

### `test/`

Suite automatizada do Worker e da base operacional.

### `scripts/run-vitest-sequential.mjs`

Runner canonico do `npm test`. Separa specs Node e Cloudflare para manter a suite deterministica e agora descobre `*.test.js` e `*.test.ts`.

### `tsconfig.json`

Fundacao TypeScript do Worker. Mantem `.js` e `.ts` coexistindo com `allowJs`, `strict` e `noEmit`, enquanto o runtime agora tem bootstrap principal em `src/index.ts`.

### `worker-configuration.d.ts`

Tipos gerados pelo Wrangler para o Worker. O arquivo e mantido em sincronia com `npm run cf:types` e validado no CI.

### `package.json`

Define `src/index.ts` como entrypoint canonico e expoe os comandos oficiais:
`npm run typecheck`, `npm run cf:types`, `npm test`, `npm run dev` e os
deploys por ambiente.

## Estado final da migracao TypeScript

A migracao central esta encerrada para a epic #186. O detalhe canonico fica em
[Migracao TypeScript](Migracao-TypeScript), incluindo ondas, comandos, entrypoints
e excecoes JavaScript restantes.

Resumo operacional:

- Worker canonico: `src/index.ts`
- App Hono: `src/app.ts`
- Rotas centrais: `src/routes/*.ts`
- Repositories D1: `src/db/repositories/*.ts`
- Tipos compartilhados: `src/types/*.ts`
- Runner de testes: `scripts/run-vitest-sequential.mjs`
- Validacao/rollback: [Validacao e Rollback TypeScript](Validacao-e-Rollback-TypeScript)

## Regra de manutencao

Se uma mudanca altera arquitetura, schema, integracao ou operacao, a documentacao correspondente precisa mudar na mesma PR.
