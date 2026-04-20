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

## Fluxo de issue para PR

- issue pequena, clara e de baixo risco pode seguir direto para branch e PR
- a triagem automatica usa `impact` como sinal descritivo, nao como roteador rigido por si so
- `direct_pr` so vale quando o escopo ja esta claro, limitado e executavel sem rodada de planning
- `discussion_before_pr` vale quando ainda falta decisao compartilhada sobre escopo, decomposicao, arquitetura, operacao, risco ou dependencias
- a triagem automatica registra justificativa, debate resumido, racional de rota e proximo passo na propria issue
- a triagem automatica nao cria Discussion; ela so publica a rota canonica na issue
- quando a rota for `discussion_before_pr`, o workflow `AI Issue Planning Review` e disparado explicitamente pela triagem via `workflow_dispatch` para criar ou reutilizar uma unica Discussion canonica da issue
- o trigger `issue_comment` do planning continua restrito a comentarios novos do `github-actions[bot]` com marcador automatizado da triage; comentarios humanos, comentarios editados e comentarios em PR nao podem iniciar ou rerodar planning
- para issues antigas ou ja roteadas antes deste contrato, o caminho oficial de migracao continua sendo `workflow_dispatch` do `AI Issue Planning Review` com `issue_number`; esse rerun cria ou reutiliza a Discussion canonica da issue
- o backfill de issues em andamento e manual por desenho: listar as issues abertas ja marcadas como `discussion_before_pr` e executar `AI Issue Planning Review` com `issue_number` para cada uma
- a categoria da Discussion de planning pode ser configurada por `AI_ISSUE_PLANNING_DISCUSSION_CATEGORY`; se ausente, o workflow aceita temporariamente `AI_ISSUE_TRIAGE_DISCUSSION_CATEGORY` como fallback de migracao e depois usa `Ideas`
- a lane de planning review roda quatro papeis especializados: `product`, `technical`, `scrum` e `risk`
- o planning review tem tres estados canonicos:
  - `Approve`: issue pronta para execucao
  - `Blocked`: issue boa e bem especificada, mas ainda depende de trabalho upstream explicito
  - `Request changes`: issue ainda tem lacuna real de backlog, decomposicao, aceite, ordem ou evidencia
- a issue so deve ser tratada como pronta para execucao quando os quatro papeis retornarem `Approve`
- quando o planning aprova, ele publica na propria issue `canonical_state: issue_ready_for_codex` e `ready_for_codex: true`
- Codex so deve entrar para abrir branch e PR depois desse handoff canonico ou quando a triage direta publicar `ready_for_codex: true`
- a thread canonica de cada nova rodada e a reply humana na conclusao mais recente da Discussion
- a automacao le a conclusao mais recente e as replies humanas nessa thread como handoff da rodada seguinte
- quando uma nova rodada aprova, a automacao responde nessa thread explicando por que agora passou
- comentarios automatizados antigos dos especialistas nao devem entrar como contexto bruto da nova rodada; o contexto operacional valido e a thread da conclusao e comentarios humanos soltos relevantes
- se a Discussion ja existia antes do gate ou se o workflow precisar ser reexecutado sem novo comentario, o mantenedor pode usar `workflow_dispatch` do `AI Issue Planning Review` informando `issue_number` ou `discussion_number`
- itens antigos nao sao backfilled automaticamente; a operacao deve reenfileirar esses casos explicitamente pelo `workflow_dispatch` com `issue_number`, nunca por edicao ou comentario humano com marker colado
- se houver falso positivo ou falha operacional na lane de planning review, o mantenedor deve registrar a ocorrencia na propria Discussion, ajustar escopo ou contexto quando necessario e rerodar o workflow antes de seguir
- enquanto a issue estiver em planning, a evolucao da issue e da Discussion pertence aos workflows via API; o implementador/Codex so entra depois do estado `ready_for_codex: true`
- a PR continua sendo a unidade de execucao do trabalho; a Discussion so entra como gate quando o risco justificar
- o parser de referencias do planning nao deve tratar mencoes em prosa como `PR #209` ou `pull request #209` como child issues; apenas referencias reais de issues entram na lista de contexto
- referencias opcionais de child issue que retornem `403` ou `404` devem ser ignoradas com aviso operacional, sem abortar o planning da issue raiz

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

## AI PR review gate

- PR pequena de baixo risco pode ficar no review direto quando muda apenas docs/testes, toca no maximo 3 arquivos, altera no maximo 120 linhas e cruza no maximo 2 areas de topo
- PR pequena que ajusta somente workflow sem tocar permissoes, segredos, `GITHUB_TOKEN`, `pull_request_target` ou escopo de escrita tambem pode ficar no review direto
- PR pequena que ajusta a propria automacao de review pode ficar no review direto quando se limita a workflow, `scripts/ai-pr-review.mjs`, testes focados e esta pagina, sem tocar permissoes, segredos ou tokens
- PR que muda codigo de produto, workflow sensivel, configuracao critica, prompt operacional, script, integracao ou comportamento entra em Discussion antes do merge
- PR grande de docs/testes tambem entra em Discussion, porque tamanho por si so aumenta risco de revisao
- a Discussion e um artefato de revisao: produto/escopo, tecnica/arquitetura, risco/operacao e sintese final
- a Discussion e append-only: cada execucao da automacao adiciona novos comentarios ate publicar um comentario final de status
- comentarios antigos nunca devem ser editados ou removidos
- a thread canonica da rodada seguinte e a reply humana na conclusao automatizada mais recente
- a automacao le a conclusao anterior e as replies humanas nessa thread antes de emitir nova rodada
- quando a PR passar numa rodada seguinte, a automacao deve responder na thread da conclusao explicando por que os bloqueios anteriores deixaram de valer
- quando uma PR cair em Discussion, o autor deve ler a sintese, responder pontos materiais na propria Discussion e ajustar a PR quando houver `Request changes`
- na lane de Discussion, a PR so fica pronta para merge quando `product`, `technical` e `risk` retornarem `Approve`; `Request changes` em qualquer um deles sempre falha o check
- a lane de PR continua binaria: aqui nao existe `Blocked`; esse estado vale so para planning de issue
- `synthesis` continua obrigatoria para visibilidade e fechamento operacional da Discussion, mas e resumo: ela nao vira um quarto voto de bloqueio por drift de redacao
- se a publicacao da Discussion falhar, o workflow deve publicar fallback na PR e falhar o check, porque a saida publica da Discussion ficou incompleta
- se uma chamada ao modelo falhar ou estourar timeout, a automacao deve publicar `Request changes` e registrar o motivo na Discussion ou fallback da PR
