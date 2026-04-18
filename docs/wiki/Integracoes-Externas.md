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
- o recheck por fallback ainda nao entrou no fluxo operacional real

## Regra operacional central

Webhook de deposito e o caminho principal de confirmacao. `deposit-status` e `deposits` sao fallback de reconciliacao e suporte.

Na persistencia local, `depositEntryId` e `qrId` nao sao sinonimos. O create-deposit grava primeiro `depositEntryId`; quando o webhook chega antes da correlacao local, o runtime consulta `deposit-status` para descobrir e gravar o `qrId` canonico.

Se a correlacao remota devolver um `qrId` que ja pertence a outro deposito local, o webhook falha explicitamente com conflito em vez de sobrescrever dados ou mascarar ambiguidade.

## Split em deposit

Toda chamada real de `deposit` deve carregar split do tenant. O codigo nao aceita endereco ou fee de split vindos do operador na rota operacional; ele resolve `depixSplitAddress` e `splitFee` a partir dos bindings secretos do tenant.

Antes de chamar a Eulen, o diagnostico valida se o split foi materializado e se nao parece placeholder. Isso evita transformar erro de configuracao local em erro 520 upstream.

O `depixSplitAddress` aceita o endereco de recebimento gerado pela SideSwap. Na pratica, isso inclui enderecos Liquid confidenciais com prefixo `lq1`. O runtime remove espacos visuais antes de montar o payload para a Eulen.
