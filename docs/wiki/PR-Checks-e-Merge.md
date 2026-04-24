# PR Checks e Merge

## Objetivo

Registrar em um unico lugar quais checks bloqueiam merge em `main` e quais checks sao apenas informativos.

## Fonte de verdade

A classificacao canonica vive em `docs/check-classification.yml`.

O fluxo de PR consome esse arquivo para decidir se um check e:

- `required`
- `informative`

## Convencao atual

### Obrigatorio

- `CI / Test`

### Informativos

- `AI PR Review / discussion-review`
- `AI Wiki Update / update-wiki`

## Regra de merge

Somente checks classificados como `required` devem bloquear merge.

Checks classificados como `informative` podem:

- falhar
- cancelar
- emitir warning

Sem virar bloqueio vermelho enganoso para merge.

## Efeito esperado no fluxo

- `CI / Test` continua sendo o gate canonico de merge
- `discussion-review` continua produzindo contexto e warnings, mas sem bloquear merge
- `update-wiki` continua tentando sincronizar a wiki e reportar warnings, mas sem bloquear merge

## Regra de manutencao

Se um check mudar de classe, a mudanca precisa acontecer em dois lugares na mesma PR:

1. `docs/check-classification.yml`
2. esta pagina
