# Integracoes Externas

## Objetivo

Fixar os contratos externos principais do MVP: Telegram e Eulen.

## Telegram

Papel no sistema:

- canal de entrada do usuario
- um bot por parceiro
- um webhook por tenant

Estado atual no `main`:

- runtime `grammY` bootstrapado existe
- a rota canônica existe
- o processamento real do update ainda nao esta mergeado em `main`

## Eulen

Papel no sistema:

- gerar cobranca DePix
- devolver QR
- confirmar pagamento por webhook

Headers mais importantes:

- `Authorization`
- `X-Nonce`
- `X-Async`

Endpoints relevantes do MVP:

- `ping`
- `deposit`
- `deposit-status`
- `deposits`
- webhook de deposito

## Regra operacional mais importante

O webhook de deposito e o caminho principal de confirmacao. `deposit-status` e `deposits` existem como fallback e reconciliacao, nao como fluxo normal de sucesso.

## Limites que influenciam desenho

- `deposit`: 15 ops/min
- `deposit-status`: 60 ops/min
- `deposits`: 12 ops/min

Esses limites explicam por que o webhook deve ser a confirmacao primaria e por que o recheck precisa ser contido.
