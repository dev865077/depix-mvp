# Contexto do MVP

> [!tip]
> Este e o ponto de entrada historico da documentacao do projeto.

> [!note]
> Para navegacao canonica, use [README.md](./README.md), [docs/README.md](./docs/README.md) e a [Wiki do projeto](https://github.com/dev865077/depix-mvp/wiki).

## Objetivo

Centralizar o contexto do MVP e fixar as decisoes que nao devem mais ficar soltas entre varias notas.

## Decisoes travadas

- `Cloudflare Worker` unico como runtime do MVP
- `Hono` para HTTP, rotas e middleware
- `grammY` para Telegram
- `XState` para conversa e estado do pedido
- `Cloudflare D1` com SQL cru via API nativa para persistencia
- `Vitest` + integracao de testes do `Cloudflare Workers` + `MSW`
- `deposit webhook` como fonte primaria de confirmacao
- `deposit-status` e `deposits` apenas como fallback
- split obrigatorio em toda cobranca do MVP
- filas, painel interno e servicos separados ficam fora do MVP

## Ordem de leitura

1. [Faturamento Automações.md](./Faturamento%20Automações.md)
2. [Arquitetura Tecnica do MVP.md](./Arquitetura%20Tecnica%20do%20MVP.md)
3. [Backlog Scrum do MVP.md](./Backlog%20Scrum%20do%20MVP.md)
4. [KANBAN.md](./KANBAN.md)

## Documentos essenciais

- [Faturamento Automações.md](./Faturamento%20Automações.md)
- [Arquitetura Tecnica do MVP.md](./Arquitetura%20Tecnica%20do%20MVP.md)
- [Backlog Scrum do MVP.md](./Backlog%20Scrum%20do%20MVP.md)
- [KANBAN.md](./KANBAN.md)
- [Mapa de Uso da API.md](./Mapa%20de%20Uso%20da%20API.md)
- [docs/README.md](./docs/README.md)
- [Pix2DePix API - Documentacao Completa.md](./docs/Pix2DePix%20API%20-%20Documentacao%20Completa.md)

## Plano resumido

- Fundacao: Worker, configuracao segura, `D1` com SQL cru e client Eulen
- Bot: webhook Telegram com `grammY`, conversa guiada por `XState` e criacao do pedido
- Cobranca: `deposit` com split, QR ao usuario e persistencia
- Confirmacao: webhook Eulen, mapeamento de status e fallback
- Qualidade: logs fortes e testes extensivos

## Como o sistema funciona de ponta a ponta

O MVP e um bot transacional no Telegram para vender `DePix`.

O fluxo completo e:

1. o usuario entra no bot no Telegram
2. `grammY` recebe a mensagem e entrega para o `Cloudflare Worker`
3. `Hono` roteia a entrada para o fluxo correto
4. `XState` decide em que etapa da conversa e do pedido o usuario esta
5. o sistema coleta ativo, valor e carteira
6. quando os dados minimos ficam completos, o sistema cria ou atualiza um pedido interno
7. o `deposit service` chama a Eulen para gerar a cobranca Pix
8. a Eulen devolve `qrCopyPaste` e `qrImageUrl`
9. o bot responde ao usuario com os dados de pagamento
10. a Eulen envia o `deposit webhook` quando houver confirmacao
11. o `webhook service` persiste o evento e atualiza pedido e cobranca
12. se necessario, o `recheck service` usa `deposit-status` e `deposits` como fallback
13. o sistema conclui o pedido ou envia para tratamento operacional

## Leitura correta da arquitetura

As pecas do MVP sao:

- `Telegram`: canal de entrada do usuario
- `grammY`: camada do bot
- `Hono`: borda HTTP do `Cloudflare Worker`
- `XState`: motor de estados da conversa e do pedido
- `order service`: cria e atualiza o pedido
- `deposit service`: cria a cobranca na Eulen
- `webhook service`: processa confirmacoes de pagamento
- `recheck service`: reconcilia quando webhook falhar, atrasar ou divergir
- `Cloudflare D1`: persistencia de conversa, pedido, cobranca e eventos
- `client Eulen`: camada isolada de integracao HTTP com a API da Eulen

## Papel do `XState`

`XState` nao e detalhe; ele e parte central da arquitetura.

Ele existe para:

- guiar a conversa no Telegram
- controlar as transicoes validas do pedido
- evitar regra espalhada entre bot, servicos e webhook
- impedir regressao de estado e duplicidade de conclusao

Leitura pratica:

- `grammY` recebe a mensagem
- `Hono` entrega para o fluxo interno
- `XState` calcula a proxima transicao valida
- os servicos executam a acao correspondente
- `D1` persiste o novo estado

## Sobre o diagrama simplificado de faturamento

O diagrama de faturamento mostra bem a integracao externa:

- Telegram
- Worker
- banco
- client Eulen
- Eulen API
- webhook de deposito

Mas ele simplifica demais a orquestracao interna e por isso pode passar a impressao errada de que `XState` nao participa.

A leitura correta e:

- o diagrama de faturamento mostra o caminho externo da cobranca e confirmacao
- a arquitetura interna completa inclui `XState` entre a entrada do bot, os servicos de aplicacao e a persistencia
- o nome `Cliente Eulen` significa o client da API da Eulen dentro do nosso sistema, nao um cliente humano

## Regra de entendimento do MVP

Para entender o sistema sem se perder:

1. `grammY` e a interface conversacional
2. `Hono` e a porta de entrada HTTP
3. `XState` e o cerebro do fluxo
4. os services executam cada responsabilidade de negocio
5. `Cloudflare D1` guarda o estado duravel
6. a Eulen cuida da cobranca e da confirmacao primaria
7. o fallback existe para recuperar consistencia quando o webhook nao bastar

## Regra de escopo

- um deploy
- um banco
- uma integracao de bot
- uma integracao de pagamento
- nada de microservicos no MVP
