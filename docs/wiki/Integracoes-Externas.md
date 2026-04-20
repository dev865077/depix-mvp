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
- o bot ja tem um fluxo inicial de resposta para `/start`, `/help` e mensagens de texto
- ao receber `/start` ou texto comum, o runtime persiste ou retoma o pedido ativo do usuario em `orders`
- ao receber `/help`, o runtime pode ler o pedido aberto para contextualizar a resposta, mas nao cria nem muta pedidos
- o primeiro passo persistido do pedido iniciado pelo bot agora e `amount`
- o valor informado pelo usuario na etapa `amount` e interpretado de forma conservadora como BRL antes de avancar para `wallet`
- o endereco informado pelo usuario na etapa `wallet` e validado de forma conservadora como DePix/Liquid antes de avancar para `confirmation`
- em `confirmation`, `sim`, `confirmar` e `ok` disparam a criacao do deposito real na Eulen
- na criacao do deposito, o payload enviado para `POST /deposit` inclui o `depixAddress` informado pelo usuario, junto do split do tenant
- em `confirmation`, `cancelar` encerra o pedido sem criar deposito
- o fluxo tambem aceita `/cancel`, `cancelar` e `recomecar` para cancelar ou reiniciar pedidos abertos em `amount`, `wallet` e `confirmation`
- `recomecar` so reinicia quando existe contexto aberto; caso contrario, apenas orienta o usuario a usar `/start`
- mensagens invalidas de valor ou endereco nao avancam o pedido e retornam orientacao de correcao
- replays de mensagens antigas nao sobrescrevem um pedido que ja avancou para `wallet`
- replays de mensagens antigas nao sobrescrevem um pedido que ja avancou para `confirmation`
- pedidos terminais e `manual_review` nao devem ser retomados como conversa editavel pelo Telegram
- alias legado terminal, como `paid`, tambem fica fora de lookup de pedido aberto
- outbound do Telegram ja tem logs estruturados e mapeamento explicito de erro
- apos conciliacao de pagamento, o sistema pode enviar uma mensagem assincrona de confirmacao ao chat original quando houver `telegram_chat_id` valido e transicao visivel relevante
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

- o webhook principal de deposito ja existe no `main`
- a validacao do header `Authorization` e a idempotencia base ja estao implementadas
- o runtime correlaciona `qrId` do webhook com `depositEntryId` local quando a cobranca ainda nao tinha `qrId` persistido
- o recheck operacional por `deposit-status` ja entrou no fluxo real usando `depositEntryId` como ancora local
- o fallback por janela via `deposits` ja existe para reconciliar linhas compactas por `qrId`
- a confirmacao do Telegram agora resolve a resposta async da Eulen antes de responder ao usuario
- a criacao de deposito persiste `orders` e `deposits` juntos para evitar duplicidade silenciosa
- em falha da Eulen, o pedido e marcado como `failed` e o usuario recebe instrucoes para recomecar

## Regra operacional central

Webhook de deposito e o caminho principal de confirmacao. `deposit-status` e `deposits` sao fallback de reconciliacao e suporte.

O endpoint operacional `POST /ops/:tenantId/recheck/deposit` consulta `deposit-status` para um `depositEntryId` especifico, registra o evento como `recheck_deposit_status` e aplica a verdade reconciliada sem atravessar tenants.

Essa rota nao e publica por tenant apenas pelo path. Ela exige `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>` e fica desabilitada quando o segredo operacional nao estiver configurado.

O recheck e aditivo ao caminho principal: webhook continua sendo a confirmacao canonica, `deposit-status` cobre um deposito especifico e `deposits` cobre uma janela curta quando callbacks atrasarem ou faltarem.

Na persistencia local, `depositEntryId` e `qrId` nao sao sinonimos. O create-deposit grava primeiro `depositEntryId`; quando o webhook chega antes da correlacao local, o runtime consulta `deposit-status` para descobrir e gravar o `qrId` canonico.

Se a correlacao remota devolver um `qrId` que ja pertence a outro deposito local, o webhook falha explicitamente com conflito em vez de sobrescrever dados ou mascarar ambiguidade.

No recheck operacional, a mesma politica vale para `deposit-status`: conflito de ownership de `qrId` devolve `deposit_qr_id_conflict`, e divergencia com um `qrId` ja correlacionado no deposito alvo devolve `deposit_qr_id_mismatch`.

O write path do recheck foi desenhado para manter auditoria e agregado alinhados: o evento `recheck_deposit_status` e os updates em `deposits`/`orders` sao persistidos no mesmo batch do D1.

Regra de precedencia atual: se o agregado local ja estiver concluido por `depix_sent`, um `deposit-status` atrasado com estado inferior nao sobrescreve o estado local; a rota responde `deposit_status_regression`.

No fallback por `deposits`, a correlacao e feita por `qrId` porque o endpoint remoto retorna uma lista compacta. Linhas sem `qrId` local correspondente sao ignoradas com resultado `skipped`, e linhas que tentariam regredir um agregado concluido tambem nao escrevem no banco. Quando a linha e aplicavel, o runtime grava `deposit_events.source = "recheck_deposits_list"` junto dos updates em `deposits` e `orders`.

Quando a conciliacao define um estado de pagamento confirmado, o service de notificacao pode derivar o `chat.id` persistido no pedido e disparar a mensagem de confirmacao. Esse envio nao substitui a verdade financeira: e apenas um side effect humano, separado do commit principal.

## Split em deposit

Toda chamada real de `deposit` deve carregar split do tenant. O codigo nao aceita endereco ou fee de split vindos do operador na rota operacional; ele resolve `depixSplitAddress` e `splitFee` a partir dos bindings secretos do tenant.

Antes de chamar a Eulen, o diagnostico valida se o split foi materializado e se nao parece placeholder. Isso evita transformar erro de configuracao local em erro 520 upstream.

O `depixSplitAddress` aceita o endereco de recebimento gerado pela SideSwap. Na pratica, isso inclui enderecos Liquid confidenciais com prefixo `lq1` e enderecos documentados `ex1`. O runtime remove espacos visuais e normaliza o texto antes de montar o payload para a Eulen.
