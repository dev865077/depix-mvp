# Estrutura do Repositorio

## Objetivo

Dar uma leitura rapida da arvore principal do projeto e do papel de cada diretório.

## Estrutura principal

```text
src/
  app.js
  index.js
  clients/
  config/
  db/
  lib/
  middleware/
  routes/
  telegram/
test/
migrations/
docs/
.github/workflows/
```

## Leitura por area

### `src/app.js`

Composicao principal do `Hono`, middleware, tratamento global de erro e montagem das rotas.

### `src/routes/`

Borda HTTP canonica do projeto:

- `health.js`
- `telegram.js`
- `webhooks.js`
- `ops.js`

### `src/config/`

Configuracao de runtime e tenants, incluindo leitura de `TENANT_REGISTRY` e secret bindings.

### `src/telegram/`

Bootstrap e cache do runtime do Telegram.

### `src/db/`

Client do `D1` e repositories operacionais.

### `src/clients/`

Integracoes HTTP externas. Hoje o caso principal e a Eulen.

### `migrations/`

Schema versionado do `D1`.

### `test/`

Suite atual do projeto. Ela existe, mas o CI automatico do repositorio esta pausado temporariamente.

## Regra para novas features

Uma mudanca nova deve entrar respeitando as fronteiras atuais:

- borda HTTP em `routes`
- regra de runtime/config em `config`
- integracoes externas em `clients`
- persistencia em `db/repositories`
- docs atualizadas na mesma PR quando houver impacto estrutural
