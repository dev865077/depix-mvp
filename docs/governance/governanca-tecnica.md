# Governanca Tecnica

## Objetivo

Dar uma casa unica para backlog estrutural, disciplina de evolucao e decisoes permanentes.

## Como o backlog esta organizado

O projeto hoje trabalha com:

- user stories
- sub-issues
- dev stories
- PRs pequenas e coesas

## Regra de priorizacao

- seguir o backlog existente
- nao puxar item com dependencia aberta
- priorizar `P0` antes de `P1`

## Estado atual de disciplina tecnica

Ja existe regra forte para:

- branch propria
- PR obrigatoria
- documentacao na mesma PR quando o impacto for estrutural

O que ainda precisa ganhar forma mais madura no repo:

- arvore formal de ADRs
- backlog tecnico estrutural mais consolidado
- runbooks operacionais mais completos

## ADRs

Os ADRs deste projeto devem morar em `docs/adr/`.

Formato esperado:

- Contexto
- Decisao
- Alternativas consideradas
- Consequencias
- Status

## Regra de longo prazo

Se uma decisao muda a forma do sistema, ela nao deve ficar apenas em issue, comentario ou memoria oral. Ela precisa ficar registrada em documentacao versionada.
