# DePix MVP

`depix-mvp` e agora o shell HTTP do produto depois da separacao dos sistemas.
As responsabilidades operacionais foram movidas para repositorios proprios:

| Repositorio | Responsabilidade |
| --- | --- |
| [`dev865077/DeBot`](https://github.com/dev865077/DeBot) | Bot Telegram, conversa, comandos, callbacks e chamadas para a API financeira. |
| [`dev865077/Sagui`](https://github.com/dev865077/Sagui) | API financeira, pagamentos, Eulen, webhooks financeiros e reconciliacao operacional. |
| [`dev865077/AutoIA-Github`](https://github.com/dev865077/AutoIA-Github) | Automacoes de GitHub, prompts, triagem, review e workflows de IA. |

Este repositorio permanece como ponto institucional e Worker minimo do produto.
Ele nao contem mais runtime Telegram ativo, implementacao financeira ativa,
migrations D1 financeiras ou automacoes GitHub de IA.

## Leitura rapida

- produto atual neste repo: Worker `Hono` com `/health`
- stack local: `Cloudflare Workers`, `Hono`, `TypeScript`
- documentacao profunda: [docs/wiki/Home.md](./docs/wiki/Home.md)
- inventario operacional: [docs/operations/secrets-and-environment-inventory.md](./docs/operations/secrets-and-environment-inventory.md)

## Estrutura atual

```text
src/                  Worker shell, healthcheck, runtime config e libs HTTP
test/                 Suite automatizada do shell
docs/                 Documentacao tecnica e historico da separacao
docs/wiki/            Wiki espelhada e versionada
.github/workflows/    CI do repositorio
wrangler.jsonc        Configuracao do Worker shell
```

Pontos de entrada:

- `src/index.ts`: bootstrap canonico do Worker
- `src/app.ts`: composicao do app `Hono`
- `src/routes/health.ts`: healthcheck publico

## Desenvolvimento

```bash
npm install
npm run dev
```

## Verificacao

```bash
npm test
npm run typecheck
npm run cf:types
```

## Deploy

```bash
npm run deploy:test
npm run deploy:production
```

## Regra de ownership

Mudancas de bot entram no `DeBot`.
Mudancas financeiras entram no `Sagui`.
Mudancas de automacao GitHub entram no `AutoIA-Github`.
Este repositorio deve continuar pequeno e sem reintroduzir runtime misto.
