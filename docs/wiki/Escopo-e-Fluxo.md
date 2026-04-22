# Escopo e Fluxo

## Fluxo principal alvo do MVP

1. Usuario fala com o bot do parceiro.
2. `Hono` resolve o `tenantId`.
3. `grammY` recebe o update.
4. `XState` calcula a transicao valida.
5. `Order Service` persiste `draft` e `currentStep`.
6. `Deposit Service` chama a Eulen para criar a cobranca.
7. O sistema persiste pedido e cobranca.
8. O usuario recebe o QR.
9. O webhook da Eulen confirma o status.
10. O sistema atualiza `deposit_events`, `deposits` e `orders`.
11. Quando o pagamento e conciliado em estado visivel, o usuario recebe uma confirmacao assincrona no Telegram.

## Regras de dados importantes

- `tenantId` deve existir nas tabelas operacionais
- `nonce` representa a intencao da cobranca
- o nonce enviado para a Eulen no `X-Nonce` deve ser um UUID estavel por pedido Telegram
- quando o pedido real ja usa `order_<uuid>`, o runtime reaproveita esse UUID como nonce canonico
- para filas legadas ou ids sem UUID embutido, o sistema gera um UUID deterministico para manter idempotencia por pedido
- `depositEntryId` corresponde ao `response.id` da Eulen
- `qrId` pode existir como identificador distinto depois e deve ser persistido sem sobrescrever `depositEntryId`
- escritas criticas multi-tabela devem usar `env.DB.batch()`
- o fluxo Telegram agora coleta o valor do pedido em `amount` antes de avancar para `wallet`
- o fluxo Telegram agora coleta o endereco DePix/Liquid em `wallet` antes de avancar para `confirmation`
- em `confirmation`, `sim`, `confirmar` e `ok` criam o deposito real; `cancelar` encerra o pedido
- o fluxo Telegram tambem aceita `/cancel`, `cancelar`, `recomecar` e `/help` como controles de conversa para pedidos abertos em `amount`, `wallet` e `confirmation`
- `/start` pode iniciar uma nova conversa ou retomar o pedido aberto mais recente
- `/iniciar` funciona como alias de `/start`
- a primeira resposta de `/start` agora explica os comandos disponiveis e mostra apenas um botao inline `Comprar DePix`
- ao clicar em `Comprar DePix`, o bot pede o valor em BRL para seguir com a compra
- se existir um pedido aberto em `amount`, `wallet` ou `confirmation` que ficou inativo por tempo demais, o runtime expira essa conversa antes de processar novas mensagens ou callbacks
- quando a conversa expira, o usuario recebe uma mensagem indicando que o pedido anterior foi encerrado com seguranca e que a conversa recomeça do inicio
- `/help` e somente informativo: pode ler o pedido aberto para contextualizar a resposta, mas nao cria pedido novo nem altera o pedido existente
- `recomecar` reinicia com seguranca sem criar pedido novo quando nao houver contexto aberto
- valores BRL simples aceitos no chat devem ser conservadores e nao ambíguos
- replays de mensagens antigas nao devem sobrescrever um pedido ja avancado para `wallet`
- replays de mensagens antigas nao devem sobrescrever um pedido ja avancado para `confirmation`
- a confirmacao assincrona pos-pagamento deve ser tratada como side effect idempotente, acionada apenas quando a transicao financeira visivel for relevante
- em `confirmation`, o fluxo agora pode enviar CTAs inline de `Confirmar` e `Cancelar`
- no estado `awaiting_payment`, a resposta de status e a entrega do QR agora podem incluir CTAs inline de `Ver status` e `Ajuda`
- callback queries desses CTAs sao tratadas pelo mesmo fluxo de pedido, preservando o fallback por texto
- quando existe uma mensagem canonica persistida no pedido, o fluxo pode editar esse mesmo payload em vez de enviar um novo message para cada etapa relevante
- as mensagens de `wallet`, `confirmation` e do valor invalido agora sao renderizadas com entidades do Telegram, em vez de texto plano, para preservar a formatação visivel sem alterar a navegacao ou o comportamento financeiro
- as respostas de status, replay e confirmacao de pagamento no Telegram agora sao enviadas como mensagens novas ou fotos novas, sem edicao da mensagem canonica antiga
- as respostas de confirmacao de pagamento agora sao concisas, em texto puro, sem QR, e podem incluir um link para a transacao Liquid quando o identificador estiver disponivel
- a mensagem de confirmacao nao deve embutir o Pix/QR do pedido; ela deve se limitar ao recibo de pagamento e ao encaminhamento para a transacao

## Fora de escopo

- microservicos
- fila como peca central do MVP
- painel interno
- arquitetura distribuida

## Estado atual do `main`

- as fronteiras canonicas de rota ja existem
- a resolucao de tenant no path ja existe
- a persistencia base ja existe
- a maquina XState da progressao inicial ja materializa e persiste o pedido inicial em `draft`
- o runtime do Telegram ja retoma o pedido aberto mais recente do usuario quando recebe `/start` ou texto comum
- `/start` agora inicia o pedido persistido em `amount` e reusa o pedido aberto mais recente sem criar duplicata
- a primeira resposta de `/start` agora apresenta os comandos e o CTA `Comprar DePix` antes de pedir o valor
- o clique em `Comprar DePix` leva diretamente ao prompt de valor em BRL
- `/start` reconsulta um pedido `awaiting_payment` contra a Eulen antes de responder, quando o pedido ja possui deposito local, para refletir imediatamente um pagamento que tenha sido finalizado fora do webhook local
- `/status` tambem reconsulta um pedido `awaiting_payment` contra a Eulen antes de responder, usando a mesma reconciliacao existente, quando ha deposito local disponivel
- a etapa `amount` agora valida valor BRL enviado no Telegram, persiste `amountInCents` e avanca o pedido para `wallet` quando a mensagem e valida
- a etapa `wallet` agora valida endereco DePix/Liquid enviado no Telegram, persiste `walletAddress` e avanca o pedido para `confirmation`
- o fluxo Telegram agora responde a controles de cancelamento e reinicio sem abrir pedido novo indevidamente quando nao existe contexto
- `/help` responde com orientacao contextual sem mutar o pedido aberto
- mensagens invalidas mantem o pedido no passo atual e orientam o usuario a reenviar a informacao correta
- a confirmacao de pedido ainda depende da integracao completa com a Eulen para criar o deposito final
- o processamento real do fluxo ainda esta incompleto
- a notificacao assincrona pos-pagamento ja faz parte do estado atual do sistema quando a conciliacao confirma o pagamento
- quando o pedido ja tiver mensagem canonica persistida, a entrega do QR e a atualizacao de status podem reutilizar a mesma mensagem em vez de abrir um novo thread de mensagens no chat
- as respostas de status, replay e confirmacao de pagamento agora sao publicadas como novas mensagens ou fotos, nao como edicoes da mensagem anterior
- a confirmacao de pagamento no Telegram passou a ser um recibo curto em texto, sem QR, com link para a transacao Liquid quando disponivel
- a resposta de confirmacao preserva a formatação visivel via entidades do Telegram quando o texto passa por replies diretas, mensagens canonicas ou captions de foto

## Leitura correta

Esta pagina descreve o fluxo alvo do MVP, nao a lista de handlers ja implementados. Quando houver diferenca entre escopo e estado do `main`, prevalece o que o codigo e a pagina de estado atual documentam.
