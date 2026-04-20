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
- `impact` e sinal descritivo; a rota depende de clareza, risco, dependencias e necessidade de decisao compartilhada
- `direct_pr` segue direto para Codex quando a issue publicar `ready_for_codex: true`
- `discussion_before_pr` nao cria Discussion na triagem; ele aciona a lane de planning review, que cria ou reutiliza uma unica Discussion canonica via API
- quando a rota e `discussion_before_pr`, a triagem dispara explicitamente o workflow de planning por `workflow_dispatch`, em vez de depender de comentario criado pelo bot para acionar outro `issue_comment`
- a planning review roda quatro papeis especializados: produto, technical, scrum e risk
- a automacao da planning review deve ignorar metadados automatizados de triagem e de status anteriores, preservando comentarios humanos como contexto operacional
- a decisao registrada na Discussion vira insumo para a PR pequena e coesa
- a issue so deve ser tratada como pronta quando a Discussion terminar com aprovacao unanime dos quatro papeis e a propria issue publicar `canonical_state: issue_ready_for_codex`
- quando a planning review concluir `Blocked`, a issue nao esta rejeitada; ela esta especificada, mas ainda depende de trabalho upstream explicito antes da implementacao

## Regra de longo prazo

Se uma decisao muda a forma do sistema, ela nao deve ficar apenas em issue, comentario ou conversa oral. Ela precisa ficar registrada em documentacao versionada.
