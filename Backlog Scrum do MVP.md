# Backlog Scrum do MVP

Documento mestre: [[Misc/DePix/Contexto|Contexto]]

> [!tip]
> Fluxo funcional: [[Misc/DePix/Faturamento Automações|Faturamento Automacoes]]
>
> Arquitetura: [[Misc/DePix/Arquitetura Tecnica do MVP|Arquitetura Tecnica do MVP]]

## Convencao

- `Trabalho`: esforco tecnico estimado em pontos
- `Recompensa`: valor entregue ou risco removido em pontos
- `P0`: bloqueia MVP
- `P1`: importante, mas vem depois do fluxo principal

## Regra de uso

- cada item abaixo deve virar um ticket
- nao puxar item com dependencia aberta
- `P0` entra antes de `P1`
- DoD minima: aceite cumprido, teste aplicavel executado, logs previstos cobertos e erro tratado

## Stack base deste backlog

- `Hono`
- `grammY`
- `XState`
- `Cloudflare D1`
- SQL cru via API nativa do `D1`
- `Vitest`
- `MSW`

## EP01 - Base e Integracao

Total do epic: `Trabalho 15` | `Recompensa 29`

- `BG-01` Worker base com `Hono` e configuracao segura. Aceite: projeto sobe como um `Cloudflare Worker`, com `Hono`, configuracao por ambiente e secrets fora do codigo. Trabalho `5`. Recompensa `8`. Prioridade `P0`. Dep: `-`.

> [!note] Prompt de Execucao - BG-01
> ```text
> Execute o BG-01 como um engenheiro senior responsavel pela base real do MVP. Antes de editar qualquer arquivo, leia Contexto, Faturamento Automacoes, Arquitetura Tecnica do MVP e Backlog Scrum do MVP, depois inspecione o repositorio para confirmar o estado atual.
>
> Objetivo: deixar o projeto rodando como um Cloudflare Worker com Hono, configuracao por ambiente e secrets fora do codigo.
>
> Regras obrigatorias:
> - use Hono como borda HTTP principal
> - mantenha um unico Worker
> - nao deixe token, segredo ou credencial em codigo, log ou arquivo commitavel
> - diferencie ambiente local, teste e producao de forma objetiva
> - implemente a base real; nao deixe placeholder estrutural
>
> Verificacao obrigatoria:
> - confirme no repositorio que a base do Worker existe de fato
> - rode o projeto localmente no fluxo previsto da stack
> - valide que Hono esta conectado ao entrypoint do Worker
> - procure hardcode de secrets dentro do escopo e remova o que encontrar
>
> Entrega esperada:
> - implementacao completa
> - validacao executada
> - resumo dos arquivos alterados
> - comandos rodados
> - bloqueios reais, se existirem, com evidencia objetiva
> ```

- `BG-02` Persistencia com `Cloudflare D1` nativo. Aceite: existem schema e migrations SQL para `orders`, `deposits` e `deposit_events`, alem de repositorios com SQL cru parametrizado. Trabalho `5`. Recompensa `8`. Prioridade `P0`. Dep: `BG-01`.

> [!note] Prompt de Execucao - BG-02
> ```text
> Execute o BG-02 como um engenheiro senior responsavel pela persistencia do MVP. Leia Contexto, Faturamento Automacoes, Arquitetura Tecnica do MVP e Backlog Scrum do MVP, depois inspecione o repositorio para confirmar se ja existe banco, schema, migration ou padrao de acesso a dados.
>
> Objetivo: entregar persistencia real com Cloudflare D1 nativo para orders, deposits e deposit_events.
>
> Regras obrigatorias:
> - use D1 como banco do MVP
> - use SQL cru parametrizado via API nativa do D1
> - modele apenas o necessario para o fluxo real do MVP
> - mantenha rastreabilidade entre orderId, depositId e nonce
> - nao dependa de memoria de runtime para estado critico
>
> Verificacao obrigatoria:
> - confirme a existencia real do schema, das migrations SQL e dos repositorios nativos
> - rode o fluxo de migration ou validacao equivalente da stack
> - valide que as tres estruturas principais conseguem ser relacionadas
> - confira que o modelo cobre conversa, cobranca e webhook
>
> Entrega esperada:
> - implementacao completa
> - validacao executada
> - resumo dos arquivos alterados
> - comandos rodados
> - lacunas reais, se houver, com evidencia objetiva
> ```

- `BG-03` Client Eulen base. Aceite: existe um client isolado com `ping`, `Authorization`, `X-Nonce` e `X-Async`, pronto para ser usado pelos fluxos seguintes. Trabalho `5`. Recompensa `13`. Prioridade `P0`. Dep: `BG-01`.

> [!note] Prompt de Execucao - BG-03
> ```text
> Execute o BG-03 como um engenheiro senior responsavel pela integracao base com a Eulen. Leia Contexto, Faturamento Automacoes, Arquitetura Tecnica do MVP, Backlog Scrum do MVP e a documentacao consolidada da API. Depois inspecione o repositorio para localizar qualquer client HTTP existente que precise ser reaproveitado.
>
> Objetivo: entregar um client isolado e reutilizavel para a Eulen com ping, bearer auth, nonce e modo async.
>
> Regras obrigatorias:
> - isole a integracao em um modulo proprio
> - implemente auth via bearer token conforme a documentacao
> - trate X-Nonce e X-Async de forma explicita
> - padronize erro, timeout e retorno
> - nao invente comportamento fora da documentacao
>
> Verificacao obrigatoria:
> - confirme que o client ficou realmente isolado da regra de negocio
> - valide a montagem dos headers obrigatorios
> - rode testes, mocks ou chamadas controladas suficientes para provar ping e auth
> - confira que a base criada atende o deposit sem retrabalho estrutural
>
> Entrega esperada:
> - implementacao completa
> - validacao executada
> - resumo dos arquivos alterados
> - comandos rodados
> - limitacoes reais encontradas, se houver, com evidencia objetiva
> ```

## EP02 - Bot, Pedido e Cobranca

Total do epic: `Trabalho 19` | `Recompensa 29`

- `BG-04` Telegram com `grammY`. Aceite: o Worker recebe o webhook do Telegram e responde comandos basicos pelo `grammY`. Trabalho `5`. Recompensa `8`. Prioridade `P0`. Dep: `BG-01`.
- `BG-05` Conversa e pedido em `draft` com `XState`. Aceite: o fluxo coleta ativo, valor e carteira, com maquina explicita de estados e persistencia de `currentStep` e dados parciais no banco. Trabalho `6`. Recompensa `8`. Prioridade `P0`. Dep: `BG-02`, `BG-04`.
- `BG-06` `deposit` com split e entrega do QR. Aceite: o sistema cria cobranca com `depixSplitAddress` e `splitFee`, persiste `depositId` e envia `qrCopyPaste` e `qrImageUrl` ao usuario. Trabalho `8`. Recompensa `13`. Prioridade `P0`. Dep: `BG-03`, `BG-05`.

## EP03 - Confirmacao e Fallback

Total do epic: `Trabalho 17` | `Recompensa 34`

- `BG-07` Webhook Eulen e eventos externos. Aceite: o endpoint valida o webhook, persiste o payload e atualiza `deposit_events` e `deposits`. Trabalho `5`. Recompensa `8`. Prioridade `P0`. Dep: `BG-02`, `BG-03`.
- `BG-08` Estado interno e saida do pedido com `XState`. Aceite: `pending`, `depix_sent`, `under_review`, `error`, `expired`, `canceled` e `refunded` dirigem corretamente o pedido e sua saida final por maquina explicita de estados. Trabalho `7`. Recompensa `13`. Prioridade `P0`. Dep: `BG-05`, `BG-06`, `BG-07`.
- `BG-09` Recheck com `deposit-status` e `deposits`. Aceite: o sistema consegue reconciliar um deposito isolado ou uma janela curta sem depender do webhook. Trabalho `5`. Recompensa `13`. Prioridade `P1`. Dep: `BG-03`, `BG-07`, `BG-08`.

## EP04 - Logs e Testes

Total do epic: `Trabalho 18` | `Recompensa 34`

- `BG-10` Logs estruturados e busca operacional. Aceite: cada pedido pode ser rastreado por `orderId`, `depositId` e `nonce`, sem vazar segredo. Trabalho `4`. Recompensa `8`. Prioridade `P0`. Dep: `BG-03`, `BG-06`, `BG-07`.
- `BG-11` Testes unitarios e integracao. Aceite: existem testes para regra de pedido, maquinas `XState`, split, client Eulen e persistencia critica usando `Vitest` e `MSW`. Trabalho `7`. Recompensa `13`. Prioridade `P0`. Dep: `BG-02`, `BG-03`, `BG-06`.
- `BG-12` Testes de webhook e fluxo critico. Aceite: existem cenarios para webhook valido, webhook duplicado, ausencia de webhook com recheck e fluxo completo de cobranca. Trabalho `7`. Recompensa `13`. Prioridade `P0`. Dep: `BG-07`, `BG-08`, `BG-09`.

## Ordem sugerida de sprint

- `Sprint 0`: `BG-01` `BG-02` `BG-03`
- `Sprint 1`: `BG-04` `BG-05` `BG-06`
- `Sprint 2`: `BG-07` `BG-08` `BG-10`
- `Sprint 3`: `BG-09` `BG-11` `BG-12`

## Resumo executivo

O backlog foi reduzido para quatro epics e doze itens. A ordem prioriza primeiro a fundacao unica do Worker, depois o fluxo real do bot e da cobranca com `XState`, depois confirmacao e fallback, e por fim logs e testes fortes para fechar o MVP com seguranca.
