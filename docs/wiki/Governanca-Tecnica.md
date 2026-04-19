# Governanca Tecnica

## Como o trabalho esta organizado

- backlog versionado no repo
- issues no GitHub
- dev stories para trabalho estrutural
- PRs pequenas, coesas e com escopo explicito

## Regra de priorizacao

- seguir backlog existente
- nao puxar item com dependencia aberta
- priorizar `P0` antes de `P1`

## O que ainda precisa amadurecer

- arvore formal de ADRs independentes
- runbooks operacionais mais completos
- consolidacao final da estrategia de CI
- governanca da manutencao automatica da wiki apos merge
- governanca automatizada da entrada de issues antes da PR

## Gate de decisao antes da PR

- issue nova pode receber triagem automatica de impacto
- `baixo` segue para PR direta
- `medio` e `alto` geram Discussion com debate curto entre perspectivas de produto, tecnica e risco
- quando a triagem abrir Discussion, a issue entra na lane de planning review com quatro papeis especializados: produto, technical, scrum e risk
- a decisao registrada na Discussion vira insumo para a PR pequena e coesa
- a issue so deve ser tratada como pronta quando a Discussion terminar com aprovacao unanime dos quatro papeis

## Regra de longo prazo

Se uma decisao muda a forma do sistema, ela nao deve ficar apenas em issue, comentario ou conversa oral. Ela precisa ficar registrada em documentacao versionada.
