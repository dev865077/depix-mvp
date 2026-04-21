# Estrutura do Repositorio

## Arvore principal

```text
src/
test/
migrations/
docs/
.github/workflows/
```

## Leitura por area

### `src/app.ts`

Composicao do `Hono`, middleware, tratamento global de erro e montagem das rotas.

### `src/index.ts`

Ponto de entrada canonico do Worker. Permanece importavel como bootstrap principal do runtime.

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

Maquina de progresso de pedidos e constantes de dominio do fluxo inicial. O contrato autoritativo da maquina agora e TypeScript estrito, com exportacao mantida para consumidores que ainda carregam o ponto de entrada JS.

### `src/telegram/`

Bootstrap e cache do runtime Telegram.

### `src/db/`

Client do `D1` e repositories operacionais. O boundary do banco usa helpers tipados e modelos de persistencia explicitos para `orders`, `deposits` e `deposit_events`.

### `src/clients/`

Integracoes HTTP externas.

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

Define o comando canonico `npm run typecheck` e as dependencias minimas de tipagem usadas pela fundacao TypeScript.

## Regra de manutencao

Se uma mudanca altera arquitetura, schema, integracao ou operacao, a documentacao correspondente precisa mudar na mesma PR.
