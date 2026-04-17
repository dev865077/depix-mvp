# Testes e Qualidade

## Objetivo

Registrar a estrategia de qualidade do projeto e o estado real da automacao hoje.

## Stack de testes definida

- `Vitest`
- testes de `Cloudflare Workers`
- `MSW`

## Suite atual no repositorio

Arquivos presentes hoje:

- `test/health.test.js`
- `test/tenant-routing.test.js`
- `test/telegram-runtime.test.js`
- `test/eulen-client.test.js`
- `test/db.repositories.test.js`

## Estado atual do CI

O workflow `CI` do GitHub Actions esta pausado para execucao automatica e hoje roda apenas via `workflow_dispatch`.

Motivo registrado no proprio repo:

- estabilizacao posterior da suite no GitHub Actions
- referencia: issue `#28`

## Regra de qualidade que continua valendo

Mesmo com o CI automatico pausado, a regra de engenharia do projeto continua sendo:

- criterio de aceite cumprido
- teste aplicavel executado quando fizer sentido
- erro tratado
- logs previstos cobertos

## Leitura correta desta pagina

Esta pagina nao diz que a automacao esta resolvida. Ela diz o contrario: a suite existe, a estrategia existe, mas a confiabilidade do fluxo automatico ainda esta sendo tratada como backlog separado.
