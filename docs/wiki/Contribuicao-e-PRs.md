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

- issue pequena, clara e de baixo impacto pode seguir direto para branch e PR
- issue com impacto `medio` ou `alto` deve passar por Discussion curta antes da PR
- a triagem automatica registra justificativa, debate resumido e proximo passo na propria issue
- quando a issue cair em Discussion, o implementador deve responder ali com a decisao operacional, a ordem de execucao, o escopo da primeira PR e os riscos ou pendencias que ficam fora dela antes de abrir branch ou PR
- a PR continua sendo a unidade de execucao do trabalho; a Discussion so entra como gate quando o risco justificar

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
- comentarios antigos nunca devem ser editados ou removidos; o comentario final de status mais recente e sempre o estado canonico da automacao
- quando uma PR cair em Discussion, o autor deve ler a sintese, responder pontos materiais na propria Discussion e ajustar a PR quando houver `Request changes`
- na lane de Discussion, a PR so fica pronta para merge quando `product`, `technical` e `risk` retornarem `Approve`; `Request changes` em qualquer um deles sempre falha o check
- `synthesis` continua obrigatoria para visibilidade e fechamento operacional da Discussion, mas e resumo: ela nao vira um quarto voto de bloqueio por drift de redacao
- se a publicacao da Discussion falhar, o workflow deve publicar fallback na PR e falhar o check, porque a saida publica da Discussion ficou incompleta
- se uma chamada ao modelo falhar ou estourar timeout, a automacao deve publicar `Request changes` com erro operacional claro, sem esconder a falha
- timeout do modelo publica sintese `Request changes` e falha o check; o mantenedor pode rerodar o check ou aceitar explicitamente o risco em um fluxo manual separado
- a automacao nao fecha Discussions via API; o fechamento operacional e o comentario final append-only de status
- a categoria da Discussion pode ser configurada por `AI_PR_DISCUSSION_CATEGORY`; se a categoria configurada nao existir, o workflow usa uma categoria aberta disponivel
- texto gerado por IA publicado no GitHub deve neutralizar mencoes, imagens e links model-authored para reduzir spam e ruido operacional
- quando a triagem exigir Discussion, a issue deve trazer o acknowledgement operacional antes de qualquer branch ou PR

## Fluxo de documentacao da wiki

- a pasta `docs/wiki` e o espelho versionado da wiki
- apos merge de PR, o workflow de atualizacao da wiki atualiza `docs/wiki` automaticamente e so publica na GitHub Wiki quando ela estiver habilitada neste repositorio
- se a GitHub Wiki estiver indisponivel para a visibilidade ou plano atual, `docs/wiki` vira a fonte de verdade operacional
- mudancas manuais em pages da wiki continuam sujeitas a revisao normal de PR
- nao criar paginas novas sem necessidade real

## Leitura correta

PR pequena, coesa e verificavel e a unidade normal de progresso do projeto.
