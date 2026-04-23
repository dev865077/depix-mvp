# Automacoes e Prompts

Esta pagina e o indice auditavel dos prompts controlados pelo repositorio.

Ela cobre apenas arquivos versionados em `.github/prompts/`. Nao cobre instrucoes internas da plataforma, system prompts do provedor, secrets, tokens ou configuracoes fora do repositorio.

## Regra operacional

- prompts editaveis ficam em `.github/prompts/`
- workflows declaram os caminhos por variaveis `*_PROMPT_PATH` ou equivalentes
- a PR que adicionar um prompt novo deve atualizar esta pagina
- `test/automation-prompts-index.test.ts` falha se algum arquivo de `.github/prompts/` ficar fora deste indice

## Issue triage

| Papel | Workflow | Variavel | Prompt |
| --- | --- | --- | --- |
| triage de issue | `.github/workflows/ai-issue-triage.yml` | `AI_ISSUE_TRIAGE_PROMPT_PATH` | `.github/prompts/ai-issue-triage.md` |

## Issue planning review

| Papel | Workflow | Variavel | Prompt |
| --- | --- | --- | --- |
| doutrina compartilhada | `.github/workflows/ai-issue-planning-review.yml` | `AI_ISSUE_PLANNING_DOCTRINE_PATH` | `.github/prompts/ai-issue-planning-doctrine.md` |
| product | `.github/workflows/ai-issue-planning-review.yml` | `AI_ISSUE_PLANNING_PRODUCT_PROMPT_PATH` | `.github/prompts/ai-issue-planning-product.md` |
| technical | `.github/workflows/ai-issue-planning-review.yml` | `AI_ISSUE_PLANNING_TECHNICAL_PROMPT_PATH` | `.github/prompts/ai-issue-planning-technical.md` |
| scrum | `.github/workflows/ai-issue-planning-review.yml` | `AI_ISSUE_PLANNING_SCRUM_PROMPT_PATH` | `.github/prompts/ai-issue-planning-scrum.md` |
| risk | `.github/workflows/ai-issue-planning-review.yml` | `AI_ISSUE_PLANNING_RISK_PROMPT_PATH` | `.github/prompts/ai-issue-planning-risk.md` |

## Issue refinement e moderador

| Papel | Workflow | Variavel | Prompt |
| --- | --- | --- | --- |
| refinador de issue | `.github/workflows/ai-issue-refinement.yml` | `AI_ISSUE_REFINEMENT_PROMPT_PATH` | `.github/prompts/ai-issue-refinement.md` |
| moderador final de planning | `.github/workflows/ai-issue-refinement.yml` | `AI_ISSUE_PLANNING_MODERATOR_PROMPT_PATH` | `.github/prompts/ai-issue-planning-moderator.md` |

## PR review direta

| Papel | Workflow | Variavel | Prompt |
| --- | --- | --- | --- |
| review direta | `.github/workflows/ai-pr-review.yml` | `AI_REVIEW_PROMPT_PATH` | `.github/prompts/ai-pr-review.md` |

## PR review em Discussion

| Papel | Workflow | Variavel | Prompt |
| --- | --- | --- | --- |
| doutrina compartilhada | `.github/workflows/ai-pr-review.yml` | `AI_PR_DISCUSSION_DOCTRINE_PATH` | `.github/prompts/ai-pr-review-doctrine.md` |
| product | `.github/workflows/ai-pr-review.yml` | `AI_PR_DISCUSSION_PRODUCT_PROMPT_PATH` | `.github/prompts/ai-pr-discussion-product.md` |
| technical | `.github/workflows/ai-pr-review.yml` | `AI_PR_DISCUSSION_TECHNICAL_PROMPT_PATH` | `.github/prompts/ai-pr-discussion-technical.md` |
| risk | `.github/workflows/ai-pr-review.yml` | `AI_PR_DISCUSSION_RISK_PROMPT_PATH` | `.github/prompts/ai-pr-discussion-risk.md` |
| synthesis | `.github/workflows/ai-pr-review.yml` | `AI_PR_DISCUSSION_SYNTHESIS_PROMPT_PATH` | `.github/prompts/ai-pr-discussion-synthesis.md` |
| moderador terminal | `.github/workflows/ai-pr-review.yml` | `AI_PR_DISCUSSION_MODERATOR_PROMPT_PATH` | `.github/prompts/ai-pr-discussion-moderator.md` |

## Wiki update

| Papel | Workflow | Variavel | Prompt |
| --- | --- | --- | --- |
| manutencao automatica da wiki | `.github/workflows/ai-wiki-update.yml` | `AI_WIKI_PROMPT_PATH` | `.github/prompts/ai-wiki-update.md` |

## Como alterar um prompt

1. Edite o arquivo em `.github/prompts/`.
2. Se adicionar um arquivo novo, inclua a linha correspondente nesta pagina.
3. Rode `npm test -- test/automation-prompts-index.test.ts`.
4. Abra PR normal; prompts sao categoria sensivel e podem cair na lane de Discussion.

## Limite do contrato

Este indice torna auditavel o que o repositorio controla. Ele nao promete acesso ao prompt interno do modelo, politicas do provedor, ranking de ferramentas ou qualquer segredo injetado em runtime.
