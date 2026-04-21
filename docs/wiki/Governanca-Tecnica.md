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
- a issue em si passa a ser consolidada pela automacao via API: o corpo recebe uma secao canonica gerenciada que sintetiza estado, rota, blockers e handoff
- quando a rota e `discussion_before_pr`, a triagem dispara explicitamente o workflow de planning por `workflow_dispatch`, em vez de depender de comentario criado pelo bot para acionar outro `issue_comment`
- o workflow de planning foi endurecido para nao manter portas paralelas de entrada por `issues` ou `issue_comment`; o contrato canonico agora e a decisao da triagem + `workflow_dispatch`
- child issues criadas durante refinement devem ser enviadas para triagem via `workflow_dispatch` antes da volta ao planning do pai
- a planning review roda quatro papeis especializados: produto, technical, scrum e risk
- quando a planning review termina em `Request changes`, o proximo ator canonico deixa de ser humano por padrao: o workflow `AI Issue Refinement` assume a issue, refina titulo/corpo/decomposicao via API e responde na thread da conclusao mais recente
- a automacao de refinement pode criar ou reutilizar child issues concretas, reclassificar `epic:` falsa para `track:` e decidir entre rerodar o planning imediatamente ou parar em `issue_planning_blocked` quando o que restar for dependencia externa explicita
- child issues criadas pela automacao nao devem depender apenas do disparo visual de issue aberta para entrar na lane de triagem
- a automacao da planning review deve ignorar metadados automatizados de triagem e de status anteriores, preservando comentarios humanos como contexto operacional
- em follow-up, a revisao deve tambem carregar os ultimos memos especialistas antes de formular novos bloqueios, para evitar mover o alvo da discussao
- a decisao registrada na Discussion vira insumo para a PR pequena e coesa
- a issue so deve ser tratada como pronta quando a Discussion terminar com aprovacao unanime dos quatro papeis e a propria issue publicar `canonical_state: issue_ready_for_codex`
- o corpo humano da issue continua sendo a fonte editavel pelo operador; a secao gerenciada da automacao fica abaixo e e reescrita a cada rodada sem destruir o texto humano
- quando a planning review concluir `Blocked`, a issue nao esta rejeitada; ela esta especificada, mas ainda depende de trabalho upstream explicito antes da implementacao
- o refinement usa limite de rodadas configuravel para evitar loop infinito silencioso; quando esse limite estoura, a issue fica visivelmente fora de `ready_for_codex` e a operacao precisa de recuperacao explicita
- na review de PR por IA, qualquer `Request changes` precisa publicar um `## Blocker contract` canonico no memo, ou o resultado e tratado como invalido pela automacao
- o contrato canonico de blocker usa os mesmos rotulos em product, technical e risk para manter decisao consistente entre roles
- quando um review apontar bloqueadores de acceptance tests, a automacao consolida os contratos especialistas em um resumo deterministico e anexa a secao canonica `Acceptance tests requested`
- a reconciliacao de follow-up blockers exige ler a ultima conclusao da Discussion, transformar a resposta final em blockers testaveis canonicos e manter os bloqueios anteriores ativos ate haver alinhamento entre diff atual, evidencia explicita de arquivo de teste e `CI / Test`
- em follow-up, a revisao deve preferir a reconciliacao estavel do conjunto anterior de bloqueios em vez de reabrir um blocker mais amplo sem contradicao concreta
- approvações de follow-up nao devem apagar bloqueios ainda nao reconciliados; quando houver divergencia, a resposta final deve sair como memo deterministico de `Request changes`
- a reply humana da conclusao mais recente pode contar como evidencia complementar quando citar o cenario de validacao ou a resolucao do bloqueio; isso vale especialmente para handoffs de follow-up em que o patch atual nao carrega sozinho toda a linguagem do contrato testado
- contratos classificados como `Not testable` ficam separados em uma secao humana de resolucao, sem serem misturados com os bloqueadores testaveis
- a sintese de PR nao deve inventar anexos personalizados de acceptance tests; ela deve seguir o contrato canonico gerado pela automacao
- a conclusao do workflow `CI` deve acordar a lane de Discussion por `workflow_run`, para que a revisao de PR rode depois do resultado canonico de testes sem depender de operador procurando manualmente
- o evento `workflow_run` nao deve acionar review direto; ele existe para reconciliar Discussions abertas contra o resultado final de `CI / Test`
- o fluxo de review automatica de PR nao deve iniciar a Discussion durante `pull_request`; esse evento apenas prepara a classificacao e preserva os checks visiveis sem abrir a lane multi-comentario
- a Discussion de review deve ser retomada por `workflow_run` somente depois que o `CI / Test` canonico estiver verde
- a evidencia operacional precisa registrar o contrato de nao-cancelamento: o run que publica comentarios de Discussion nao deve ser cancelado por reuse de concurrency group entre eventos `pull_request` e `workflow_run`
- os checks visiveis do PR devem permanecer coerentes com o gatilho canonico, sem duplicar o mesmo review entre eventos concorrentes
- a visibilidade do check `AI PR Review / discussion-review` no `pull_request` deve ser preservada mesmo quando a revisao especializada aguarda o CI verde
- o gate de CI deve ser explicitado no proprio workflow de review para que especialistas so executem depois do `CI / Test` canonico concluir com sucesso
- falhas operacionais de GitHub API, permissao, schema e logs de GitHub Actions devem ser classificadas como contexto operacional antes de qualquer analise de review de conteudo
- quando a revisao automatica precisar puxar logs de falha, o contexto desses logs deve entrar no prompt de review de forma controlada e redigida, sem virar ruido nem expor segredos

## Regra de longo prazo

Se uma decisao muda a forma do sistema, ela nao deve ficar apenas em issue, comentario ou conversa oral. Ela precisa ficar registrada em documentacao versionada.
