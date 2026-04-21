# Validacao e Rollback TypeScript

Esta pagina e o contrato operacional da issue #204 para as ondas sensiveis da
migracao TypeScript. Ela define quais comandos, smokes, gates e acoes minimas
de rollback precisam existir antes de considerar cada onda segura.

## Regra geral

- cada onda deve sair em PR isolada
- uma PR de onda nao deve misturar superficies sem necessidade de rollback comum
- nenhuma onda sensivel avanca se qualquer comando ou smoke obrigatorio falhar
- falha em comando obrigatorio bloqueia merge
- falha em smoke operacional bloqueia promocao da onda afetada
- rollback tecnico minimo e reverter a PR isolada da propria onda
- rollback nao deve misturar outra onda, hotfix nao relacionado ou limpeza cosmetica
- se rollback exigir mais que revert da PR isolada, a onda anterior estava grande demais

## Matriz por onda

| Onda | Issue | Superficie | Comandos obrigatorios | Smokes obrigatorios | Gate stop/go | Rollback minimo |
| --- | --- | --- | --- | --- | --- | --- |
| Fundacao TypeScript | #179 | `tsconfig`, scripts de tipo, tipos gerados e bootstrap ainda compativel | `npm run typecheck`; `npm run cf:types`; `npm test`; `npm run dev` | Worker local sobe sem erro; `GET /health` responde `status: ok` | Go somente com tipos, testes, tipos Cloudflare e boot local verdes | Reverter a PR da fundacao; nao misturar com rollback de rotas, Telegram ou Eulen |
| Borda Telegram | #183 | parsing de update, runtime `grammY`, erro estruturado e contrato inbound | `npm test`; `npm test -- test/telegram-raw-update.test.js test/telegram-runtime.test.js test/telegram-webhook-reply.test.js` | webhook preserva falha fechada para payload invalido; tenant resolvido continua isolado por path | Go somente se payload invalido continuar retornando erro estruturado e fluxo valido continuar respondendo | Reverter a PR da borda Telegram; nao alterar registry, Eulen ou D1 no mesmo rollback |
| Borda Eulen | #203 | client Eulen, webhook de deposito, payload externo e correlacao | `npm test`; `npm test -- test/eulen-client.test.js test/eulen-webhook.test.js` | webhook Eulen rejeita segredo invalido; payload invalido falha fechado; tenant mismatch continua bloqueado | Go somente se contrato externo invalido nao atravessar para persistencia | Reverter a PR da borda Eulen; nao misturar com rollback de Telegram ou rotas `/ops` |
| Bootstrap e contexto HTTP | #199 | `src/index.ts`, `Env`, contexto Hono e middleware de runtime | `npm run typecheck`; `npm run cf:types`; `npm test`; `npm run dev` | Worker local sobe; `GET /health` funciona com `runtimeConfig`; rotas com tenant desconhecido falham fechado | Go somente se boot local, health e roteamento basico ficarem verdes | Reverter a PR de bootstrap/contexto; se o Worker nao subir, esta e a primeira PR a reverter |
| Rotas e middleware HTTP | #184 | `health`, `ops`, `telegram`, `webhooks` e resolucao de tenant | `npm test`; `npm test -- test/health.test.js test/ops-telegram-webhook.test.js test/tenant-routing.test.js` | `GET /health` redige segredos; `/ops` sem bearer nega acesso; webhook com tenant invalido falha fechado | Go somente se os caminhos HTTP positivos e negativos permanecerem explicitos | Reverter a PR de rotas/middleware; nao misturar com rollback de services internos |
| Utilitarios HTTP e erro | #200 | helpers HTTP, mapeamento de erro e autorizacao operacional tipada | `npm run typecheck`; `npm test`; `npm test -- test/health.test.js test/ops-telegram-webhook.test.js test/deposit-recheck.test.js` | erros continuam com `code` estavel; `/ops` sem token retorna erro operacional esperado; token invalido nao chama upstream | Go somente se erros publicos e logs estruturados preservarem contrato | Reverter a PR dos utilitarios; nao alterar services de negocio no mesmo rollback |
| Runtime/scripts finais | #196 | entrypoint final, cleanup de JS duplicado, runner e compatibilidade operacional | `npm run typecheck`; `npm run cf:types`; `npm test`; `npm run dev`; `npx wrangler deploy --dry-run --env test`; `npx wrangler deploy --dry-run --env production` | `GET /health` local; dry-run de `test`; dry-run de `production`; imports Node suportados por `node --import tsx` | Go somente se runtime local, CI e dry-runs provarem que `src/index.ts` e o entrypoint canonico | Reverter a PR de cleanup/runtime; nao restaurar arquivos JS individualmente sem reverter a onda |

## Smokes HTTP canonicos

Os smokes abaixo sao canonicos para ondas que alteram bootstrap, rotas,
middleware, autorizacao operacional ou entrypoint.

### Boot local e health

1. Subir o Worker local:

```bash
npm run dev -- --local --port 8790
```

2. Validar health:

```bash
curl -fsS http://127.0.0.1:8790/health
```

Passa quando a resposta e JSON valido com `status: "ok"` e sem nomes de
bindings secretos no inventario publico de tenants.

### `/ops` sem bearer

Executar contra o Worker local:

```bash
curl -sS -o /tmp/depix-ops-smoke.json -w "%{http_code}" \
  -X POST http://127.0.0.1:8790/ops/alpha/recheck/deposit \
  -H "content-type: application/json" \
  --data '{"depositEntryId":"smoke"}'
```

Passa quando a rota nao executa upstream e responde erro controlado. Em ambiente
local com a feature flag desabilitada, `503 ops_route_disabled` e esperado. Em
ambiente com a flag habilitada e sem bearer, `401 ops_authorization_required` e
esperado.

### Webhook com tenant ou payload invalido

As rotas de webhook devem falhar fechado quando o tenant nao existe ou quando o
payload nao respeita o contrato externo.

Comandos de cobertura obrigatoria:

```bash
npm test -- test/tenant-routing.test.js
npm test -- test/telegram-webhook-reply.test.js
npm test -- test/eulen-webhook.test.js
```

Passa quando tenants desconhecidos nao viram sucesso, payload invalido retorna
erro estruturado e nenhum caminho invalido grava agregado financeiro.

## Gates objetivos

Uma onda esta pronta para merge quando:

- todos os comandos obrigatorios da linha da matriz estao verdes
- todos os smokes obrigatorios da linha da matriz estao verdes ou cobertos por suite focada indicada
- `CI / Test` esta verde na PR
- a review automatizada de PR esta verde ou a Discussion canonica terminou em `pr_ready_to_merge`
- a PR nao mistura superficie fora da linha da matriz

Uma onda esta pronta para promocao operacional quando:

- a PR ja foi mergeada
- o CI em `main` ficou verde apos o merge
- dry-run de Wrangler passa quando a onda altera entrypoint, bindings, runtime ou deploy
- o operador consegue apontar qual PR isolada deve ser revertida em caso de incidente

## Evidencia minima por PR

Cada PR de onda sensivel deve declarar no corpo:

- issue ligada
- superficie alterada
- comandos executados
- smokes executados ou suite focada equivalente
- risco residual
- caminho de rollback

Para #204, a evidencia esperada e documental: esta pagina deve existir, estar
linkada na wiki e listar comandos, smokes, gates e rollback por onda.

## Ordem de rollback

1. Identificar a onda que introduziu a regressao.
2. Confirmar que a regressao pertence a superficie daquela onda.
3. Reverter a PR isolada da onda.
4. Rodar os comandos obrigatorios da propria onda revertida.
5. Rodar os smokes HTTP canonicos se a onda tocou bootstrap, rotas, middleware, autorizacao ou entrypoint.
6. Registrar no follow-up da issue ou PR qual evidencia provou a recuperacao.

Se duas ondas parecem culpadas, reverter primeiro a onda mais recente que tocou a
superficie quebrada. Nao aplicar hotfix amplo antes de confirmar que o revert
isolado nao resolve.

## Excecoes

Arquivos JavaScript podem permanecer quando forem:

- scripts operacionais `.mjs`
- configs esperadas pelo ecossistema
- helpers de teste sem valor claro de tipagem imediata
- modulos JS ainda sem equivalente TypeScript validado

Essas excecoes devem ser documentadas no fechamento final da epic em #185.
