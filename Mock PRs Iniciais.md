# Mock PRs Iniciais

Este arquivo organiza os achados atuais em PRs planejadas, ainda sem implementacao. O objetivo e deixar uma fila profissional, revisavel e pronta para os programadores escolherem a ordem de execucao.

## Regras desta fila

- Isto e planejamento, nao execucao.
- As PRs abaixo sao mock PRs iniciais.
- A ordem final pode mudar conforme estrategia, disponibilidade e dependencia tecnica.
- Antes de abrir cada PR real, ligar a um item formal do backlog, story, task ou bug.
- Cada PR real deve manter escopo coeso e atualizar docs quando aplicavel.

## Visao rapida

| PR | Prioridade | Tema | Dependencias principais |
| --- | --- | --- | --- |
| PR-PLAN-01 | P0 | Entrada Telegram real com grammY + XState | nenhuma |
| PR-PLAN-02 | P0 | Webhook Eulen + recheck operacional | PR-PLAN-01 opcional, mas nao obrigatoria |
| PR-PLAN-03 | P1 | Split obrigatorio em toda cobranca | PR-PLAN-02 recomendada |
| PR-PLAN-04 | P1 | Validacao de segredos de webhook | PR-PLAN-01 e PR-PLAN-02 recomendadas |
| PR-PLAN-05 | P2 | Cobertura de testes do fluxo MVP | PR-PLAN-01 a PR-PLAN-04 recomendadas |
| PR-PLAN-06 | P2 | Sincronizacao e espelho minimo da documentacao | nenhuma |

## PR-PLAN-01

### Titulo sugerido

`feat/telegram-core-grammy-xstate`

### Objetivo

Implementar o fluxo central do MVP na borda do Telegram, substituindo o placeholder `501` por uma entrada real com `grammY` e estrutura de maquina de estados com `XState`.

### Item ligado

- `bug` ou `task tecnica`
- converter para item formal do backlog antes da PR real

### Escopo

- adicionar dependencias e configuracao base de `grammY`
- adicionar dependencias e estrutura inicial de `XState`
- trocar o handler de `/telegram/:tenantId/webhook` de placeholder para fluxo real
- criar a fundacao do estado conversacional do pedido
- conectar o tenant atual ao bot e ao fluxo
- padronizar logs e erros do caminho Telegram
- atualizar docs impactadas

### Fora de escopo

- implementacao completa do webhook da Eulen
- reconciliacao por `deposit-status` e `deposits`
- regras finais de split obrigatorio
- cobertura de testes completa do sistema inteiro

### Risco

- alto
- principal risco: introduzir a espinha dorsal do MVP sem isolar direito responsabilidades entre borda Telegram, maquina de estados e servicos de dominio

### Validacao esperada

- testes locais do webhook Telegram
- testes de transicao de estado basica
- smoke test por tenant
- validacao manual de bootstrap do bot

### Documentacao

- atualizar `Contexto.md`
- atualizar `Faturamento Automacoes.md`
- atualizar `Arquitetura Tecnica do MVP.md`
- atualizar `Backlog Scrum do MVP.md` se houver novos subitens

### Notas de planejamento

- Esta PR materializa um dos maiores gaps entre docs e codigo atual.
- Pode comecar mesmo antes da implementacao do webhook da Eulen, desde que a interface de servico seja bem definida.

## PR-PLAN-02

### Titulo sugerido

`feat/eulen-webhook-and-recheck`

### Objetivo

Implementar a confirmacao primaria por webhook da Eulen e o fallback operacional por recheck usando `deposit-status` e `deposits`, removendo os placeholders `501` das rotas criticas.

### Item ligado

- `bug` ou `task tecnica`
- converter para item formal do backlog antes da PR real

### Escopo

- implementar `/webhooks/eulen/:tenantId/deposit`
- implementar `/ops/:tenantId/recheck/deposit`
- criar servico de aplicacao para reconciliacao de deposito
- registrar `deposit_events` com trilha de origem
- atualizar `orders` e `deposits` de forma consistente
- garantir idempotencia minima do webhook
- conectar client Eulen aos fluxos reais de consulta
- atualizar docs de operacao e arquitetura

### Fora de escopo

- refinamento completo de UX do bot Telegram
- testes completos do fluxo conversacional
- expansao para novos produtos fora de DePix

### Risco

- alto
- principal risco: inconsistencias de estado entre webhook, recheck e persistencia se a estrategia de idempotencia e batch nao ficar bem fechada

### Validacao esperada

- testes de webhook valido e repetido
- testes de recheck
- testes de persistencia e reconciliacao por tenant
- simulacao de atraso ou perda de webhook

### Documentacao

- atualizar `Contexto.md`
- atualizar `Faturamento Automacoes.md`
- atualizar `Arquitetura Tecnica do MVP.md`
- atualizar `Mapa de Uso da API.md`

### Notas de planejamento

- Esta PR fecha o outro gap P0 central do MVP.
- Idealmente deve usar `env.DB.batch()` nas escritas criticas alinhadas com a documentacao.

## PR-PLAN-03

### Titulo sugerido

`fix/split-required-on-all-charges`

### Objetivo

Garantir por implementacao que toda cobranca saia com split obrigatorio, sem depender de payload solto vindo de fora.

### Item ligado

- `bug`
- converter para item formal do backlog antes da PR real

### Escopo

- introduzir configuracao interna obrigatoria de split
- impedir criacao de cobranca sem `splitAddress` e `splitFee`
- padronizar injecao do split no servico de cobranca
- ajustar validacoes do client da Eulen para nao aceitar body cru sem contrato
- atualizar `.dev.vars.example`
- atualizar `wrangler.jsonc` ou bindings equivalentes
- revisar modelos e defaults de `orders`

### Fora de escopo

- redesenho completo do dominio de cobranca
- automatizacao completa de onboarding por tenant

### Risco

- medio
- principal risco: endurecer validacoes cedo demais sem um contrato de configuracao estavel por tenant

### Validacao esperada

- testes de tentativa sem split
- testes de criacao valida com split por tenant
- verificacao de configuracao local e de producao

### Documentacao

- atualizar `Contexto.md`
- atualizar `Faturamento Automacoes.md`
- atualizar `Arquitetura Tecnica do MVP.md`

### Notas de planejamento

- Esta PR fica mais segura quando a camada de cobranca ja estiver menos placeholder.

## PR-PLAN-04

### Titulo sugerido

`fix/webhook-secret-validation`

### Objetivo

Passar a validar efetivamente os segredos dos webhooks da Eulen e do Telegram, saindo do estado atual em que a configuracao existe mas nao protege as rotas.

### Item ligado

- `bug`
- converter para item formal do backlog antes da PR real

### Escopo

- definir estrategia de validacao para Telegram por tenant
- definir estrategia de validacao para Eulen por tenant
- implementar verificacao nas rotas reais
- garantir respostas coerentes para segredo ausente, invalido ou desconhecido
- adicionar logs e metadados seguros de falha
- revisar documentacao operacional de setup

### Fora de escopo

- rotacao automatica de segredos
- painel administrativo de seguranca

### Risco

- medio
- principal risco: bloquear chamadas legitimas por diferenca de formato, header ou estrategia de validacao entre provedores

### Validacao esperada

- testes com segredo valido
- testes com segredo invalido
- testes com tenant errado
- smoke test de configuracao por tenant

### Documentacao

- atualizar `Arquitetura Tecnica do MVP.md`
- atualizar `Mapa de Uso da API.md`
- atualizar `Contexto.md` se a regra operacional mudar

### Notas de planejamento

- Esta PR depende da existencia de handlers reais ou de uma interface clara onde a validacao possa entrar.

## PR-PLAN-05

### Titulo sugerido

`test/mvp-critical-flow-coverage`

### Objetivo

Expandir a cobertura de testes para o fluxo real do MVP, saindo da cobertura atual de fundacao tecnica para uma cobertura das regras centrais do produto.

### Item ligado

- `task tecnica`
- converter para item formal do backlog antes da PR real

### Escopo

- testes do webhook Telegram
- testes das maquinas `XState`
- testes de split obrigatorio
- testes de webhook idempotente
- testes de recheck
- testes do fluxo critico completo por tenant
- revisar fixtures, mocks e helpers de integracao

### Fora de escopo

- testes end-to-end em infraestrutura real
- observabilidade avancada

### Risco

- medio
- principal risco: escrever testes antes de o contrato do fluxo estabilizar e acabar cristalizando implementacao temporaria

### Validacao esperada

- suite local verde
- cenarios criticos cobrindo sucesso, repeticao, falha e reconciliacao

### Documentacao

- atualizar backlog se surgirem lacunas de teste ainda nao mapeadas
- atualizar docs tecnicas se os testes consolidarem contratos importantes

### Notas de planejamento

- Esta PR rende melhor depois que as PRs funcionais principais estiverem mais fechadas.

## PR-PLAN-06

### Titulo sugerido

`docs/obsidian-context-sync`

### Objetivo

Melhorar a integridade da cadeia de leitura de contexto para futuras sessoes, reduzindo perda de contexto entre Obsidian, workspace e onboarding tecnico.

### Item ligado

- `docs`
- converter para item formal do backlog antes da PR real

### Escopo

- revisar links centrais do contexto
- garantir espelho minimo no workspace dos documentos indispensaveis
- manter um resumo curto e confiavel para leitura rapida
- documentar quais arquivos sao obrigatorios no pre-flight
- reduzir dependencia de leitura espalhada para sessoes futuras

### Fora de escopo

- sincronizacao automatica completa entre Obsidian e workspace
- reorganizacao total da base documental

### Risco

- baixo
- principal risco: criar duplicacao documental sem deixar claro qual e a fonte primaria

### Validacao esperada

- leitura local dos links obrigatorios sem lacunas
- checklist inicial apontando para arquivos existentes

### Documentacao

- atualizar `Checklist de Pre-Voo.md`
- atualizar `Contexto Consolidado.md`
- atualizar docs de contribuicao se o ritual de pre-flight mudar

### Notas de planejamento

- Esta PR pode acontecer em paralelo com qualquer outra, desde que preserve a ideia de fonte primaria no Obsidian.

## Recomendacoes de execucao

- Se a equipe quiser atacar o coracao do produto primeiro, a melhor abertura e `PR-PLAN-01` seguida de `PR-PLAN-02`.
- Se a equipe quiser reduzir risco operacional cedo, `PR-PLAN-04` pode subir de prioridade assim que existirem handlers reais.
- `PR-PLAN-05` deve consolidar, nao substituir, as PRs funcionais.
- `PR-PLAN-06` e barata e melhora onboarding, mas nao substitui trabalho de produto.

## Modelo curto para abrir a PR real

```md
## Objetivo

## Item ligado
- BG-00 / US-00 / bug

## Escopo
- ...

## Fora de escopo
- ...

## Risco
- baixo / medio / alto
- principal risco:

## Validacao
- testes rodados:
- checks locais:

## Documentacao
- atualizada / nao aplicavel
```
