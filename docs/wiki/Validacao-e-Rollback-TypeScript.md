# Validacao e Rollback TypeScript

Esta pagina e o contrato operacional da issue #204 para as ondas sensiveis da migracao TypeScript. Ela define quais comandos, smokes, gates e acoes minimas de rollback precisam existir antes de considerar cada onda segura.

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
| Utilitarios HTTP e erro | #200 | helpers HTTP, mapeamento de erro e autorizacao operacional tipada | `npm run typecheck`; `npm test`; `npm test -- test/health.test.js test/ops-telegram-webhook.test.js` | respostas de erro continuam tipadas; comportamento operacional segue fail-closed | Go somente se helpers e contratos de erro continuarem consistentes | Reverter a PR de utilitarios HTTP; nao incluir mudancas de rota no mesmo rollback |
| Tipos gerados e limpeza final | #196 | tipos gerados, limpeza de runtime legado e ajuste final de compatibilidade | `npm run typecheck`; `npm run cf:types`; `npm test`; `git diff --check` | nenhum import legado quebra o bootstrap; o runtime continua subindo localmente | Go somente se nao restar quebra de compatibilidade ou ruido de diff | Reverter a PR final; se houver quebra de bootstrap, parar nesta onda e nao seguir adiante |

## Comandos base obrigatorios

Antes de promover qualquer onda sensivel, a PR deve evidenciar o conjunto aplicavel abaixo:

- `npm run typecheck`
- `npm test`
- `npm run cf:types`
- `npm run dev -- --local --port 8791`
- `git diff --check`

Nem toda onda precisa de todos os comandos acima, mas toda PR precisa listar o subconjunto executado e explicar por que ele cobre a superficie alterada.

## Smokes e validacao operacional

- `GET /health` para confirmar boot e redacao de segredos
- validacao HTTP do caminho alterado, com sucesso e falha fechada
- validacao local de bootstrap para ondas que tocam entrada do Worker
- validacao de contrato de erro para ondas que alteram bordas, helpers ou autorizacao

## Gates stop/go

Stop quando houver qualquer um destes sinais:

- comando obrigatorio falhou
- smoke obrigatorio falhou
- cobertura listada na PR nao corresponde a superficie alterada
- a PR mistura ondas que deveriam ser revertidas separadamente
- o rollback proposto depende de outra mudanca nao relacionada

Go somente quando:

- os comandos exigidos pela onda estiverem verdes
- os smokes obrigatorios estiverem verdes
- o rollback minimo estiver claro e isolado
- a PR nao depender de contrato operacional implícito

## Rollback minimo por onda

- reverter somente a PR da onda afetada
- nao embutir correcao de outra onda no mesmo revert
- se a reversao precisar de ajuste adicional, documentar a dependencia e parar a promocao
- se a onda afetar bootstrap, confirmar que o Worker ainda sobe antes de prosseguir para a proxima

## Uso prático

Use esta pagina como checklist de liberacao para as ondas sensiveis da migracao TypeScript. A referencia final de consolidacao da migracao continua em #185.
