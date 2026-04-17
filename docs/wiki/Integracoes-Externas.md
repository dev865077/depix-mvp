# Integracoes Externas

## Telegram

Papel:

- canal de entrada do usuario
- um bot por parceiro
- um webhook por tenant

Estado atual:

- runtime `grammY` bootstrapado existe
- rota canonica existe
- processamento real do update ainda nao esta no `main`

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

## Regra operacional central

Webhook de deposito e o caminho principal de confirmacao. `deposit-status` e `deposits` sao fallback de reconciliacao e suporte.
