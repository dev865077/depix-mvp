# PR Checks e Merge

## Objetivo

Registrar em um unico lugar quais checks bloqueiam merge em `main` e quais checks sao apenas informativos.

## Fonte de verdade

A classificacao canonica dos checks de automacao GitHub foi movida para
`dev865077/AutoIA-Github/docs/check-classification.yml`.

O fluxo de PR da automacao consome esse arquivo para decidir se um check e:

- `required`
- `informative`

## Convencao atual

### Obrigatorio

- `Test`

Na UI do GitHub, esse check aparece como `CI / Test`, porque o workflow se chama `CI` e o job se chama `Test`.

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

- `Test` continua sendo o gate canonico de merge; na PR ele aparece como `CI / Test`
- `discussion-review` continua produzindo contexto e warnings, mas sem bloquear merge
- `update-wiki` continua tentando sincronizar a wiki e reportar warnings, mas sem bloquear merge

## Regra de manutencao

Se um check mudar de classe, a mudanca pertence ao repositorio
`dev865077/AutoIA-Github`. Esta pagina permanece apenas como ponteiro do produto
para o destino operacional da automacao.
