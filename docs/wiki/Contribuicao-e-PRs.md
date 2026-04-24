# Contribuicao e PRs

## Regras fixas

- nunca mudar direto em `main`
- toda mudanca relevante deve sair em branch propria
- toda branch relevante deve abrir PR
- merge padrao: `Squash`

## Regras de escopo

- PR tecnica nao deve carregar mudanca documental aleatoria
- PR documental deve ser propria
- se mudar arquitetura, schema, integracao, operacao ou observabilidade, a documentacao muda na mesma PR
- se mudar entrypoint, runner, comandos canonicos, contratos de runtime ou excecoes JavaScript restantes, atualizar [Migracao TypeScript](Migracao-TypeScript) na mesma PR

## Fluxo de issue para PR

- `epic` nao e sinonimo de item importante; use `epic` apenas quando o artefato agrupar varias sub-issues executaveis com dependencia e ordem explicitas
- item unico, gap operacional, readiness track ou checklist de release nao deve usar prefixo `epic:`; nesses casos prefira issue normal, `track:` ou `gap:`
- issue pequena, clara e de baixo risco pode seguir direto para branch e PR
- a triagem automatica usa `impact` como sinal descritivo, nao como roteador rigido por si so
- `direct_pr` so vale quando o escopo ja esta claro, limitado e executavel sem rodada de planning
- `discussion_before_pr` vale quando ainda falta decisao compartilhada sobre escopo, decomposicao, arquitetura, operacao, risco ou dependencias
- a triagem automatica registra justificativa, debate resumido, racional de rota e proximo passo na propria issue
- a triagem automatica tambem atualiza uma secao canonica gerenciada por API no corpo da propria issue; o texto humano continua acima dessa secao
- a triagem automatica nao cria Discussion; ela so publica a rota canonica na issue
- quando a rota for `discussion_before_pr`, o workflow `AI Issue Planning Review` e disparado explicitamente pela triagem via `workflow_dispatch` para criar ou reutilizar uma unica Discussion canonica da issue
- o planning nao deve ouvir `issues` nem `issue_comment` como entrada automatica paralela; esses gatilhos redundantes foram removidos para manter uma unica porta canonica de planejamento
- quando o planning terminar em `Request changes`, o workflow `AI Issue Refinement` deve entrar automaticamente, refinar a issue via API, responder na thread da conclusao mais recente e decidir se o planning deve rerodar agora ou se a issue ja amadureceu ate um bloqueio externo explicito
- o refinement pode criar child issues concretas e, quando isso acontecer, deve despachar a triagem desses child issues via `workflow_dispatch` antes de rerodar o planning do pai
- as child issues criadas por refinement nao devem depender apenas do trigger visual de abertura para entrar em triagem
- para issues antigas ou ja roteadas antes desse contrato, o caminho oficial de migracao continua sendo `workflow_dispatch` do `AI Issue Planning Review` com `issue_number`; esse rerun cria ou reutiliza a Discussion canonica da issue
- o backfill de issues em andamento e manual por desenho: listar as issues abertas ja marcadas como `discussion_before_pr` e executar `AI Issue Planning Review` com `issue_number` para cada uma
- a categoria da Discussion de planning pode ser configurada por `AI_ISSUE_PLANNING_DISCUSSION_CATEGORY`; se ausente, o workflow aceita temporariamente `AI_ISSUE_TRIAGE_DISCUSSION_CATEGORY` como fallback de migracao e depois usa `Ideas`
- a lane de planning review roda quatro papeis especializados: `product`, `technical`, `scrum` e `risk`
- se uma issue vier titulada como `epic:` sem varias child issues concretas, a planning review deve tratar isso como problema de backlog e pedir correcao
- o planning review tem tres estados canonicos:
  - `Approve`: issue pronta para execucao
  - `Blocked`: issue boa e bem especificada, mas ainda depende de trabalho upstream explicito
  - `Request changes`: issue ainda tem lacuna real de backlog, decomposicao, aceite, ordem ou evidencia
- `Blocked` nao deve abrir loop novo de refinement por padrao; ele encerra a rodada automatica da issue ate a dependencia externa mudar
- a issue so deve ser tratada como pronta para execucao quando os quatro papeis retornarem `Approve`
- quando o planning aprova, ele publica na propria issue `canonical_state: issue_ready_for_codex` e `ready_for_codex: true`
- durante o planning, a automacao tambem reescreve a secao gerenciada do corpo da issue com sintese de produto, tecnica, scrum e risco, para que a issue amadureca sem depender de Codex
- durante o refinement, a automacao continua dona da issue: ela pode reescrever titulo e corpo humano, criar child issues concretas, atualizar a secao gerenciada e publicar o estado canonico antes de reabrir o planning
- Codex so deve entrar para abrir branch e PR depois desse handoff canonico ou quando a triage direta publicar `ready_for_codex: true`
- a thread canonica de cada nova rodada e a reply humana na conclusao mais recente da Discussion
- a automacao le a conclusao mais recente e as replies humanas nessa thread como handoff da rodada seguinte
- a reply automatizada de refinement tambem acontece nessa mesma thread canonica e pode disparar o proximo `workflow_dispatch` do planning sem intervencao humana
- quando uma nova rodada aprova, a automacao responde nessa thread explicando por que agora passou
- comentarios automatizados antigos dos especialistas nao devem entrar como contexto bruto da nova rodada; o contexto operacional valido e a thread da conclusao e comentarios humanos soltos relevantes
- quando houver follow-up, a automacao deve incorporar tambem os ultimos memos dos revisores especialistas antes de abrir novos blockers, para evitar regressao de contexto
- se a Discussion ja existia antes do gate ou se o workflow precisar ser reexecutado sem novo comentario, o mantenedor pode usar `workflow_dispatch` do `AI Issue Planning Review` informando `issue_number` ou `discussion_number`
- itens antigos nao sao backfilled automaticamente; a operacao deve reenfileirar esses casos explicitamente pelo `workflow_dispatch` com `issue_number`, nunca por edicao ou comentario humano com marker colado
- se houver falso positivo ou falha operacional na lane de planning review ou refinement, o mantenedor deve registrar a ocorrencia na propria Discussion e rerodar o workflow apropriado; a automacao normal nao deve depender de comentario humano para evoluir a issue
- enquanto a issue estiver em planning, a evolucao da issue e da Discussion pertence aos workflows via API; o implementador/Codex so entra depois do estado `ready_for_codex: true`
- a PR continua sendo a unidade de execucao do trabalho; a Discussion so entra como gate quando o risco justificar
- a convencao canonica de checks obrigatorios e informativos do fluxo de PR fica em [PR-Checks-e-Merge](PR-Checks-e-Merge)
- o parser de referencias do planning nao deve tratar mencoes em prosa como `PR #209` ou `pull request #209` como child issues; apenas referencias reais de issues entram na lista de contexto
- referencias opcionais de child issue que retornem `403` ou `404` devem ser ignoradas com aviso operacional, sem abortar o planning da issue raiz
- a revisao automatica de PR deve manter o check `AI PR Review / discussion-review` visivel no `pull_request`
- a Discussion de PR agora tem rounds comuns limitados; quando o payload expuser contexto de round, a revisao deve usar esse numero para calibrar severidade e convergir sem reabrir debate antigo
- depois do limite configurado de rounds comuns, um moderador terminal emite a decisao final da Discussion de PR; revisores especialistas nao devem tentar contornar esse limite
- quando a revisÃ£o cair no caminho terminal de moderador, a saida precisa continuar coerente com o contrato canonico da Discussion e com o estado final do check
- o contrato de review nao deve depender de edicao retroativa de comentarios anteriores; cada rodada continua append-only
- quando um review apontar bloqueadores de acceptance tests, a automacao consolida os contratos especialistas em um resumo deterministico e anexa a secao canonica `Acceptance tests requested`
- a reconciliacao de follow-up blockers exige ler a ultima conclusao da Discussion, transformar a resposta final em blockers testaveis canonicos e manter os bloqueios anteriores ativos ate haver alinhamento entre diff atual, evidencia explicita de arquivo de teste e `CI / Test`
- em follow-up, a revisao deve preferir a reconciliacao estavel do conjunto anterior de bloqueios em vez de reabrir um blocker mais amplo sem contradicao concreta
- approvaÃ§Ãµes de follow-up nao devem apagar bloqueios ainda nao reconciliados; quando houver divergencia, a resposta final deve sair como memo deterministico de `Request changes`
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

Se uma decisao muda a forma do sistema, ela nao deve ficar apenas em PR ou issue; deve virar contrato documental.
