# DePix MVP Wiki 2.0

Camada institucional e navegavel da documentacao do `depix-mvp`.

## O que este sistema e

O `depix-mvp` e uma plataforma multi-tenant de bot Telegram para o fluxo `DePix`, executada sobre um unico `Cloudflare Worker` e um unico banco `D1`, com isolamento logico por `tenantId`.

## O que este repositorio contem

- um unico runtime em `Cloudflare Workers`
- borda HTTP em `Hono`
- runtime de bot em `grammY`
- persistencia em `D1` para `orders`, `deposits` e `deposit_events`
- contratos explicitos de persistencia em TypeScript para a borda D1
- bootstrap principal do Worker em `src/index.ts`
- contrato de runtime tipado em `src/types/runtime.ts`
- rotas HTTP centrais em TypeScript para `health`, `ops`, `telegram` e `webhooks`
- glue de autorizacao operacional do `/ops` em TypeScript
- integracao com a Eulen para criacao, confirmacao e recheck de depositos
- ambientes de `test` e `production` no Cloudflare
- documentacao tecnica versionada em `docs/`

## Estado atual em uma leitura

- `Hono` ja e a borda HTTP real do Worker
- a fundacao multi-tenant ja existe no `main`
- o webhook do Telegram ja faz despacho real para `grammY`
- o inbound do Telegram agora normaliza um contrato explicito de update com `updateKind`, `chatId`, `fromId`, `text`, `command`, `callbackData`, `hasReplyChannel` e `rawUpdateType`
- payload inbound invalido no Telegram falha fechado com erro estruturado `invalid_webhook_payload`
- o bot Telegram ja tem fluxo inicial para `/start`, `/help`, texto comum e updates nao suportados
- a superficie publica canonica do Telegram agora e registrada no webhook com os comandos visiveis `/start`, `/help`, `/status` e `/cancel`
- o perfil publico do bot agora tambem recebe descricao curta e descricao completa informando o fluxo basico antes do usuario pressionar Start
- o alias legado `/iniciar` segue aceito em runtime, mas fica fora da listagem publica canonica
- o menu button do Telegram espelha a mesma superficie publica canonica de comandos
- o `/start` inicial agora orienta o usuario com a lista de comandos e mostra um unico CTA inline `Comprar DePix`
- o callback `Comprar DePix` leva o usuario para o prompt de informar o valor em BRL
- o webhook do Telegram agora inclui `callback_query` entre os `allowed_updates`, para manter a UX inline alcancavel
- em `confirmation`, o fluxo agora oferece CTAs inline de `Confirmar` e `Cancelar`
- no estado `awaiting_payment`, as respostas de status e entrega do QR agora podem incluir CTAs inline de `Ver status` e `Ajuda`
- callback queries suportadas sao tratadas pelo mesmo fluxo de pedido, com fallback por texto preservado
- `/start` e `/status` reconsultam um pedido `awaiting_payment` contra a Eulen antes de responder quando ha deposito local disponivel, para refletir imediato um pagamento ja conciliado externamente
- o sistema agora persiste metadados da mensagem canonica do Telegram no pedido para permitir edicao in-place do mesmo payload ao longo do fluxo
- o sistema agora persiste `created_request_id` em `deposits` e `request_id` em `deposit_events` para ligar a trilha operacional usada no coletor de evidencia da release 0.1
- o sistema agora persiste `correlation_id` canonico em `orders`, com backfill de linhas legadas via migracao
- o `correlation_id` e propagado nos logs de Telegram, no webhook da Eulen, no recheck de deposito e na telemetria do client Eulen
- a borda de webhook do Telegram e a borda de webhook da Eulen agora aplicam rate limit centralizado por `tenantId` e IP em ambientes nao locais
- o limite atual e de 60 requests por minuto por `tenantId` + IP, com resposta `429` e `Retry-After` quando excedido
- em ambiente `local`, o rate limit de webhook nao introduce espera para nao atrapalhar testes e fluxos de desenvolvimento
- `D1` ja guarda `orders`, `deposits` e `deposit_events`
- os repositories centrais de `orders`, `deposits` e `deposit_events` agora usam contratos de persistencia explicitados em TypeScript
- o bootstrap do Worker foi movido para `src/index.ts`
- o boundary canonico de tipos do runtime foi consolidado em `src/types/runtime.ts`
- as rotas HTTP centrais `health`, `ops`, `telegram` e `webhooks` foram migradas para TypeScript
- o glue de autorizacao operacional das rotas `ops` foi migrado para TypeScript
- o webhook principal da Eulen ja existe com validacao, idempotencia base e persistencia
- o recheck operacional de deposito ja existe via `POST /ops/:tenantId/recheck/deposit`
- o fallback por janela via `POST /ops/:tenantId/reconcile/deposits` ja reconcilia linhas compactas da Eulen por `qrId`
- a reconciliação agendada bounded de depositos pendentes ja existe como Cloudflare Cron Trigger no Worker Module, ativa apenas em `test` e desativada em `production`
- a conciliacao de pagamento agora pode disparar notificacao assincrona no Telegram quando o estado visivel do pedido muda para confirmacao
- a notificacao assincrona do Telegram foi desenhada para ser idempotente e nao repetir a mesma mensagem em webhook, recheck ou fallback
- a revisao automatica de PR agora permanece visivel como check `AI PR Review / discussion-review` no `pull_request`
- o gate de discussao de PR agora espera o `CI / Test` canonico ficar verde antes de rodar especialistas
- o workflow de review de PR nao depende mais de um trigger duplicado em `workflow_run` para publicar o check visivel
- a triagem de issues agora publica rota canonica na issue sem criar Discussion prematura
- a triagem de issues agora tambem atualiza uma secao canônica gerenciada no corpo da issue, para que a propria issue amadureca via API antes de entrar em implementacao
- quando a rota exigir planning, a planning review cria ou reutiliza uma unica Discussion via API, roda quatro papeis especializados, reescreve a secao canonica da issue com a sintese da rodada e, se ainda houver bloqueios, despacha automaticamente o refinement da issue antes de liberar Codex com `ready_for_codex: true`
- child issues criadas pelo refinement tambem entram em triagem por dispatch explicito, sem depender apenas do trigger visual de abertura
- a review de PR por IA agora reconcilia follow-up blockers contra o diff atual, evidencia explicita de arquivos de teste e `CI / Test` antes de descarregar bloqueios antigos
- quando a thread final traz uma reply humana com cenario de validacao ou resolucao do bloqueio, essa evidencia pode ser usada no handoff do follow-up
- quando restarem bloqueios de follow-up, a automacao publica memos deterministas de `Request changes` em vez de aprovacoes nao reconciliadas
- os prompts controlados pelo repositorio ficam auditaveis em [Automacoes e Prompts](Automacoes-e-Prompts)
- o fluxo funcional completo do bot ainda nao esta concluido
- `XState` ja materializa e persiste o pedido inicial em `draft` no runtime do Telegram, e o bot consegue retomar o pedido aberto do usuario quando ele volta a conversar
- o modulo da maquina de progresso de pedidos foi migrado para TypeScript estrito, mantendo o contrato de transicao e os consumidores com importacao minima
- o ponto de entrada JavaScript da maquina continua carregavel em Node para compatibilidade com consumidores existentes
- o `/start` agora reaproveita o pedido aberto mais recente e avanca o pedido inicial para `amount` sem duplicar a conversa
- a etapa `amount` agora aceita valores BRL simples no Telegram e avanca o pedido para `wallet` quando o valor e valido
- a etapa `wallet` agora aceita enderecos DePix/Liquid `lq1` e `ex1`, normalizando e persistindo o endereco antes de seguir para `confirmation`
- o webhook da Eulen ja valida e idempotentiza o recebimento do pagamento e atualiza o estado local antes de acionar notificacao assincrona

## O que ainda nao esta pronto

- o processamento completo do fluxo do bot ainda nao foi fechado em todas as bordas
- ainda existem etapas de operacao e conciliacao a amadurecer para o fluxo inteiro

```
