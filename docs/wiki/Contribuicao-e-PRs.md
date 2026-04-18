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

## Fluxo de documentacao da wiki

- a pasta `docs/wiki` e o espelho versionado da wiki
- apos merge de PR, o workflow de atualizacao da wiki atualiza `docs/wiki` automaticamente e so publica na GitHub Wiki quando ela estiver habilitada neste repositorio
- se a GitHub Wiki estiver indisponivel para a visibilidade ou plano atual, `docs/wiki` vira a fonte de verdade operacional
- mudancas manuais em pages da wiki continuam sujeitas a revisao normal de PR
- nao criar paginas novas sem necessidade real

## Leitura correta

PR pequena, coesa e verificavel e a unidade normal de progresso do projeto.
