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
- PR que muda codigo de produto, workflow, configuracao, prompt operacional, script, integracao ou comportamento entra em Discussion antes do merge
- PR grande de docs/testes tambem entra em Discussion, porque tamanho por si so aumenta risco de revisao
- a Discussion e um artefato de revisao: produto/escopo, tecnica/arquitetura, risco/operacao e sintese final
- a categoria da Discussion pode ser configurada por `AI_PR_DISCUSSION_CATEGORY`; se a categoria configurada nao existir, o workflow usa uma categoria aberta disponivel
- se a publicacao da Discussion falhar, o workflow deve degradar para comentario na PR com a sintese e o erro operacional, sem bloquear por indisponibilidade transitoria do GitHub Discussions
- texto gerado por IA publicado no GitHub deve neutralizar mencoes, imagens e links model-authored para reduzir spam e ruido operacional

## Fluxo de documentacao da wiki

- a pasta `docs/wiki` e o espelho versionado da wiki
- apos merge de PR, o workflow de atualizacao da wiki atualiza `docs/wiki` automaticamente e so publica na GitHub Wiki quando ela estiver habilitada neste repositorio
- se a GitHub Wiki estiver indisponivel para a visibilidade ou plano atual, `docs/wiki` vira a fonte de verdade operacional
- mudancas manuais em pages da wiki continuam sujeitas a revisao normal de PR
- nao criar paginas novas sem necessidade real

## Leitura correta

PR pequena, coesa e verificavel e a unidade normal de progresso do projeto.
