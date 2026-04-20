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

### `src/app.js`

Composicao do `Hono`, middleware, tratamento global de erro e montagem das rotas.

### `src/routes/`

Borda HTTP canonica:

- `health.js`
- `telegram.js`
- `webhooks.js`
- `ops.js`

### `src/config/`

Runtime, tenants e resolucao de bindings.

### `src/telegram/`

Bootstrap e cache do runtime Telegram.

### `src/db/`

Client do `D1` e repositories operacionais.

### `src/clients/`

Integracoes HTTP externas.

### `migrations/`

Schema inicial e evolucao multi-tenant.

### `test/`

Suite automatizada do Worker e da base operacional.

### `tsconfig.json`

Fundacao TypeScript do Worker. Mantem `.js` e `.ts` coexistindo com `allowJs`, `strict` e `noEmit`, enquanto o runtime continua ancorado em `src/index.js`.

### `worker-configuration.d.ts`

Tipos gerados pelo Wrangler para o Worker. O arquivo e mantido em sincronia com `npm run cf:types` e validado no CI.

### `package.json`

Define o comando canonico `npm run typecheck` e as dependencias minimas de tipagem usadas pela fundacao TypeScript.

## Regra de manutencao

Se uma mudanca altera arquitetura, schema, integracao ou operacao, a documentacao correspondente precisa mudar na mesma PR.
