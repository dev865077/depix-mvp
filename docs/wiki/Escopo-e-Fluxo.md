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

## Regras de dados importantes

- `tenantId` deve existir nas tabelas operacionais
- `nonce` representa a intencao da cobranca
- `depositEntryId` corresponde ao `response.id` da Eulen
- `qrId` pode existir como identificador distinto depois e deve ser persistido sem sobrescrever `depositEntryId`
- escritas criticas multi-tabela devem usar `env.DB.batch()`

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
- o processamento real do fluxo ainda esta incompleto

## Leitura correta

Esta pagina descreve o fluxo alvo do MVP, nao a lista de handlers ja implementados em producao.

Para o desenho atual da maquina de pedidos, veja [XState e Fluxo de Pedidos](XState-e-Fluxo-de-Pedidos).
