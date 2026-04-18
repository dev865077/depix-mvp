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
- o recheck por fallback ainda nao entrou no fluxo operacional real

## Regra operacional central

Webhook de deposito e o caminho principal de confirmacao. `deposit-status` e `deposits` sao fallback de reconciliacao e suporte.
