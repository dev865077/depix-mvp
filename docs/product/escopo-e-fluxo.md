# Escopo e Fluxo Principal

## Objetivo

Fixar o fluxo principal do MVP e deixar claro o que esta dentro e o que esta fora do escopo.

## Fluxo principal alvo do MVP

1. Usuario fala com o bot do parceiro.
2. `Hono` resolve o `tenantId` na entrada.
3. `grammY` recebe o update e entrega para o fluxo interno.
4. `XState` calcula a transicao valida da conversa e do pedido.
5. `Order Service` persiste `draft` e `currentStep`.
6. Quando o pedido fica completo, `Deposit Service` chama `POST /deposit` na Eulen.
7. O sistema persiste `order`, `deposit` e o estado associado.
8. O usuario recebe o QR.
9. O webhook da Eulen confirma o status.
10. O sistema atualiza `deposit_events`, `deposits` e `orders`.

## Regras de dados mais importantes

- `tenantId` deve existir nas tabelas operacionais
- `depositEntryId` corresponde ao `response.id` do `POST /deposit`
- `qrId` pode chegar depois via webhook ou fallback
- `nonce` representa a intencao da cobranca e deve ser reutilizado em retry
- writes multi-tabela criticos devem usar `env.DB.batch()`

## O que fica fora do MVP

- microservicos
- filas como peca central
- painel interno
- arquitetura distribuida
- automacoes operacionais sofisticadas

## Estado atual do `main`

O `main` ja materializa a borda HTTP multi-tenant e os placeholders canonicos de rota. O fluxo principal acima continua sendo a direcao arquitetural do MVP, nao um retrato literal do que ja esta mergeado hoje.
