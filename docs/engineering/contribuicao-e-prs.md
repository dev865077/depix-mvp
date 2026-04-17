# Contribuicao e PRs

## Objetivo

Consolidar o fluxo de contribuicao do projeto sem depender de nota solta.

## Regras fixas

- nunca mudar direto em `main`
- toda mudanca deve sair em branch propria
- toda branch relevante deve abrir PR
- merge padrao: `Squash`

## Regras de escopo

- PR tecnica nao deve carregar mudanca documental aleatoria
- PR documental deve ser propria
- se mudar arquitetura, schema, integracao, operacao ou observabilidade, a documentacao muda na mesma PR

## Como abrir uma PR boa

Uma PR deve ser:

- coesa
- pequena o suficiente para revisar
- ligada a um item real do backlog
- clara sobre risco e validacao

## Corpo obrigatorio da PR

- Objetivo
- Item ligado
- Escopo
- Fora de escopo
- Risco
- Validacao executada
- Impacto em documentacao

## Regra extra para PR com IA

Explicitar:

- o que foi assumido
- o que foi validado
- o que nao foi validado
- qual risco residual ficou aberto

## Politica de backlog

- todo trabalho deve nascer de item real de backlog, story, task ou bug
- nao puxar item com dependencia aberta
- priorizar `P0` antes de `P1`
