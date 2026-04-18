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
- o bot ja tem um fluxo inicial de resposta para `/start` e mensagens de texto
- ao receber `/start` ou texto comum, o runtime persiste ou retoma o pedido ativo do usuario em `orders`
- o primeiro passo persistido do pedido iniciado pelo bot agora e `amount`
- o valor informado pelo usuario na etapa `amount` e interpretado de forma conservadora como BRL antes de avancar para `wallet`
- mensagens invalidas de valor nao avancam o pedido e retornam orientacao de correcao
- replays de mensagens antigas nao sobrescrevem um pedido que ja avancou para `wallet`
- outbound do Telegram ja tem logs estruturados e mapeamento explicito de erro

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

## Regra operacional central

Webhook de deposito e o caminho principal de confirmacao. `deposit-status` e `deposits` sao fallback de reconciliacao e suporte.

O endpoint operacional `POST /ops/:tenantId/recheck/deposit` consulta `deposit-status` para um `depositEntryId` especifico, registra o evento como `recheck_deposit_status` e aplica a verdade reconciliada sem atravessar tenants.

Essa rota nao e publica por tenant apenas pelo path. Ela exige `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>` e fica desabilitada quando o segredo operacional nao estiver configurado.

O recheck e aditivo ao caminho principal: webhook continua sendo a confirmacao canonica, `deposit-status` cobre um deposito especifico e `deposits` cobre uma janela curta quando callbacks atrasarem ou faltarem.

Na persistencia local, `depositEntryId` e `qrId` nao sao sinonimos. O create-deposit grava primeiro `depositEntryId`; quando o webhook chega antes da correlacao local, o runtime consulta `deposit-status` para descobrir e gravar o `qrId` canonico.

Se a correlacao remota devolver um `qrId` que ja pertence a outro deposito local, o webhook falha explicitamente com conflito em vez de sobrescrever dados ou mascarar ambiguidade.

No recheck operacional, a mesma politica vale para `deposit-status`: conflito de ownership de `qrId` devolve `deposit_qr_id_conflict`, e divergencia com um `qrId` ja correlacionado no deposito alvo devolve `deposit_qr_id_mismatch`.

O write path do recheck foi desenhado para manter auditoria e agregado alinhados: o evento `recheck_deposit_status` e os updates em `deposits`/`orders` sao persistidos no mesmo batch do D1.

Regra de precedencia atual: se o agregado local ja estiver concluido por `depix_sent`, um `deposit-status` atrasado com estado inferior nao terminal nao sobrescreve o estado local; a rota responde `deposit_status_regression`.

No fallback por `deposits`, a correlacao e feita por `qrId` porque o endpoint remoto retorna uma lista compacta. Linhas sem `qrId` local correspondente sao ignoradas com resultado `skipped`, e linhas que tentariam regredir um agregado concluido tambem nao escrevem no banco. Quando a linha e aplicavel, o runtime grava `deposit_events.source = "recheck_deposits_list"` junto dos updates em `deposits` e `orders`.

## Split em deposit

Toda chamada real de `deposit` deve carregar split do tenant. O codigo nao aceita endereco ou fee de split vindos do operador na rota operacional; ele resolve `depixSplitAddress` e `splitFee` a partir dos bindings secretos do tenant.

Antes de chamar a Eulen, o diagnostico valida se o split foi materializado e se nao parece placeholder. Isso evita transformar erro de configuracao local em erro 520 upstream.

O `depixSplitAddress` aceita o endereco de recebimento gerado pela SideSwap. Na pratica, isso inclui enderecos Liquid confidenciais com prefixo `lq1`. O runtime remove espacos visuais antes de montar o payload para a Eulen.
