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
- o workflow de planning foi endurecido para nao manter portas paralelas de entrada por `issues` ou `issue_comment`; o contrato canonico agora e a decisao da triagem + `workflow_dispatch`
- a planning review roda quatro papeis especializados: produto, technical, scrum e risk
- a automacao da planning review deve ignorar metadados automatizados de triagem e de status anteriores, preservando comentarios humanos como contexto operacional
- em follow-up, a revisao deve tambem carregar os ultimos memos especialistas antes de formular novos bloqueios, para evitar mover o alvo da discussao
- a decisao registrada na Discussion vira insumo para a PR pequena e coesa
- a issue so deve ser tratada como pronta quando a Discussion terminar com aprovacao unanime dos quatro papeis e a propria issue publicar `canonical_state: issue_ready_for_codex`
- quando a planning review concluir `Blocked`, a issue nao esta rejeitada; ela esta especificada, mas ainda depende de trabalho upstream explicito antes da implementacao
- na review de PR por IA, qualquer `Request changes` precisa publicar um `## Blocker contract` canonico no memo, ou o resultado e tratado como invalido pela automacao
- o contrato canonico de blocker usa os mesmos rotulos em product, technical e risk para manter decisao consistente entre roles
- quando um review apontar bloqueadores de acceptance tests, a automacao consolida os contratos especialistas em um resumo deterministico e anexa a secao canonica `Acceptance tests requested`
- a reconciliacao de follow-up blockers exige ler a ultima conclusao da Discussion, transformar a resposta final em blockers testaveis canonicos e manter os bloqueios anteriores ativos ate haver alinhamento entre diff atual, evidencia explicita de arquivo de teste e `CI / Test`
- em follow-up, a revisao deve preferir a reconciliacao estavel do conjunto anterior de bloqueios em vez de reabrir um blocker mais amplo sem contradicao concreta
- approvações de follow-up nao devem apagar bloqueios ainda nao reconciliados; quando houver divergencia, a resposta final deve sair como memo deterministico de `Request changes`
- a reply humana da conclusao mais recente pode contar como evidencia complementar quando citar o cenario de validacao ou a resolucao do bloqueio; isso vale especialmente para handoffs de follow-up em que o patch atual nao carrega sozinho toda a linguagem do contrato testado
- contratos classificados como `Not testable` ficam separados em uma secao humana de resolucao, sem serem misturados com os bloqueadores testaveis
- a sintese de PR nao deve inventar anexos personalizados de acceptance tests; ela deve seguir o contrato canonico gerado pela automacao
- falhas operacionais de GitHub API, permissao, schema e logs de GitHub Actions devem ser classificadas como contexto operacional antes de qualquer analise de review de conteudo
- quando a revisao automatica precisar puxar logs de falha, o contexto desses logs deve entrar no prompt de review de forma controlada e redigida, sem virar ruido nem expor segredos

## Regra de longo prazo

Se uma decisao muda a forma do sistema, ela nao deve ficar apenas em issue, comentario ou conversa oral. Ela precisa ficar registrada em documentacao versionada.
