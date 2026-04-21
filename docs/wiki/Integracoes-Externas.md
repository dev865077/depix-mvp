# Integracoes Externas

## Telegram

Papel:

- canal de entrada do usuario
- um bot por parceiro
- um webhook por tenant

Estado atual:

- runtime `grammY` bootstrapado existe
- rota canonica existe
- o webhook ja despacha o update real para o runtime do tenant
- o inbound do Telegram agora passa por normalizacao com contrato explicito antes de chegar ao fluxo do bot
- o update inbound invalido falha fechado com erro estruturado `invalid_webhook_payload`
- o bot ja tem um fluxo inicial de resposta para `/start`, `/help` e mensagens de texto
- ao receber `/start` ou texto comum, o runtime persiste ou retoma o pedido ativo do usuario em `orders`
- ao receber `/help`, o runtime pode ler o pedido aberto para contextualizar a resposta, mas nao cria nem muta pedidos
- o primeiro passo persistido do pedido iniciado pelo bot agora e `amount`
- o valor informado pelo usuario na etapa `amount` e interpretado de forma conservadora como BRL antes de avancar para `wallet`
- o endereco informado pelo usuario na etapa `wallet` e validado de forma conservadora como DePix/Liquid antes de avancar para `confirmation`
- em `confirmation`, `sim`, `confirmar` e `ok` disparam a criacao do deposito real na Eulen
- na criacao do deposito, o payload enviado para `POST /deposit` inclui o `depixAddress` informado pelo usuario, junto do split do tenant
- o `X-Nonce` enviado para a Eulen usa um UUID estavel por pedido Telegram; quando o pedido real ja usa `order_<uuid>`, esse UUID e reaproveitado diretamente
- em linhas legadas sem UUID embutido no `orderId`, o nonce continua deterministico, mas sempre em formato UUID
- em `confirmation`, `cancelar` encerra o pedido sem criar deposito
- o fluxo tambem aceita `/cancel`, `cancelar` e `recomecar` para cancelar ou reiniciar pedidos abertos em `amount`, `wallet` e `confirmation`
- `recomecar` so reinicia quando existe contexto aberto; caso contrario, apenas orienta o usuario a usar `/start`
- o comando `/status` consulta o pedido aberto atual; se nao houver pedido aberto, ele mostra o ultimo pedido relevante do mesmo tenant/usuario/canal sem criar ou alterar linhas
- `/status` e somente leitura: nao reabre pedido terminal, nao cria pedido novo e nao muda o estado do agregado
- mensagens invalidas de valor ou endereco nao avancam o pedido e retornam orientacao de correcao
- replays de mensagens antigas nao sobrescrevem um pedido que ja avancou para `wallet`
- replays de mensagens antigas nao sobrescrevem um pedido que ja avancou para `confirmation`
- pedidos terminais e `manual_review` nao devem ser retomados como conversa editavel pelo Telegram
- alias legado terminal, como `paid`, tambem fica fora de lookup de pedido aberto
- outbound do Telegram ja tem logs estruturados e mapeamento explicito de erro
- apos conciliacao de pagamento, o sistema pode enviar uma mensagem assincrona de confirmacao ao chat original quando houver `telegram_chat_id` valido e transicao visivel relevante
- a copy do QR pode informar a expiracao apenas quando a Eulen devolver esse dado; quando o Telegram nao aceitar a imagem do QR, o fluxo deve cair para texto simples sem perder a instrucoes de pagamento
- essa notificacao assincrona e idempotente por transicao visivel: webhook, recheck e fallback nao devem repetir a mesma mensagem

## Eulen

Papel:

- gerar cobranca `DePix`
- devolver QR
- confirmar pagamento via webhook

Headers principais:

- `Authorization`
- `X-Nonce`
- `X-Async`

Endpoints relevantes:

- `ping`
- `deposit`
- `deposit-status`
- `deposits`
- webhook de deposito

Estado atual:

- o client da Eulen foi migrado para TypeScript, mantendo o runtime JS checado no repositorio
- as respostas de criacao de deposito agora sao resolvidas por um envelope validado antes de consumidores usarem `response.data`
- o `deposit-status` tambem passou a usar resolucao validada do payload de resposta, com erro estruturado quando o contrato externo vem invalido
- o webhook principal de deposito ja existe no `main`
- a validacao do header `Authorization` e a idempotencia base ja estao implementadas
- o runtime correlaciona `qrId` do webhook com `depositEntryId` local quando a cobranca ainda nao tinha `qrId` persistido
- a hidratacao de `qrId` agora e fail-closed: quando o webhook encontra um `qrId` desconhecido, o runtime so hidrata um deposito pendente se `deposit-status.qrId` bater exatamente com o `qrId` do webhook
- se o `qrId` remoto nao for exatamente o mesmo `qrId` do webhook, o deposito, a ordem e os eventos permanecem inalterados
- o recheck operacional por `deposit-status` ja entrou no fluxo real usando `depositEntryId` como ancora local
- o fallback por janela via `deposits` ja existe para reconciliar linhas compactas por `qrId`
- a confirmacao do Telegram agora resolve a resposta async da Eulen antes de responder ao usuario
- a expiracao do Pix so deve aparecer na mensagem quando a Eulen realmente a devolver, inclusive no caminho async de criacao do deposito
- a criacao de deposito persiste `orders` e `deposits` juntos para evitar duplicidade silenciosa
- em falha da Eulen, o pedido e marcado como `failed` e o usuario recebe instrucoes para recomecar
- o webhook canonico da Eulen de deposito agora responde a probes em `GET` e `HEAD` na mesma URL, com erro diagnosticavel `webhook_method_not_allowed`
- `POST` continua sendo o unico metodo que executa o processamento real do webhook

## Regra operacional central

Webhook de deposito e o caminho principal de confirmacao. `deposit-status` e `deposits` sao fallback de reconciliacao e suporte.

O endpoint operacional `POST /ops/:tenantId/recheck/deposit` consulta `deposit-status` para um `depositEntryId` especifico, registra o evento como `recheck_deposit_status` e aplica a verdade reconciliada sem atravessar tenants.

Essa rota nao e publica por tenant apenas pelo path. Ela exige `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>` e fica desabilitada quando o segredo operacional nao estiver configurado.

O recheck e aditivo ao caminho principal: webhook continua sendo a confirmacao canonica, `deposit-status` cobre um deposito especifico e `deposits` cobre uma janela curta quando callbacks atrasarem ou faltarem.

Na persistencia local, `depositEntryId` e `qrId` nao sao sinonimos. O create-deposit grava primeiro `depositEntryId`; quando o webhook chega antes da correlacao local, o runtime consulta `deposit-status` para descobrir e gravar o `qrId` canonico.

Se a correlacao remota devolver um `qrId` que ja pertence a outro deposito local, o webhook falha explicitamente com conflito em vez de sobrescrever dados ou mascarar ambiguidade.

No recheck operacional e nos retries de confirmacao, o nonce deve permanecer um UUID estavel por pedido, reaproveitando o UUID embutido em `order_<uuid>` quando existir.
