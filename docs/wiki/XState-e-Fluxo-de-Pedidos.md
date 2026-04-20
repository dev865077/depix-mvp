# XState e Fluxo de Pedidos

## Papel da maquina

A maquina de estados e a fonte canonica da progressao do pedido. Ela define
quais transicoes sao validas, quais eventos podem avancar o agregado e quais
passos encerram a conversa editavel do usuario.

## Estados e eventos

A implementacao atual concentra os contratos puros de dominio em
`src/order-flow/order-progress-constants.js` e a maquina em
`src/order-flow/order-progress-machine.js`.

Os estados canonicos do fluxo sao:

- `draft`
- `amount`
- `wallet`
- `confirmation`
- `creating_deposit`
- `awaiting_payment`
- `completed`
- `failed`
- `canceled`
- `manual_review`

Os eventos canonicos sao:

- `START_ORDER`
- `AMOUNT_RECEIVED`
- `WALLET_RECEIVED`
- `CUSTOMER_CONFIRMED`
- `DEPOSIT_CREATED`
- `PAYMENT_CONFIRMED`
- `FAIL_ORDER`
- `CANCEL_ORDER`

## Contrato de persistencia

Valores persistidos que nao pertencem ao vocabulario atual continuam sendo
normalizados em codigo por `normalizePersistedOrderProgressStep()`. Alias legados
conhecidos, como `paid`, seguem sendo aceitos na leitura, mas nao devem ser
tratados como conversa editavel.

Passos terminalmente editaveis e estados finais da conversa do usuario sao:

- `completed`
- `failed`
- `canceled`
- `manual_review`

Para lookup conversacional, aliases legados que normalizam para terminal, como
`paid`, tambem ficam fora de qualquer busca de pedido aberto.

## Interpretacao de `manual_review`

Estados operacionais vindos do webhook da Eulen, como revisao manual, entram no
mesmo vocabulario canonico da maquina. `manual_review` e terminal para a
conversa editavel: o Telegram nao deve retomar esse agregado para alterar valor,
endereco ou confirmacao; a continuidade passa a ser operacional, e uma nova
compra precisa nascer em outro pedido.

## Regra de evolucao

A maquina continua sendo o ponto de referencia para regras de transicao. O
runtime do Telegram, repositories SQL e services de webhook devem compartilhar o
mesmo vocabulario para evitar divergencia entre estado persistido e retomada da
conversa.

## Aliases legados

Aliases legados conhecidos sao normalizados em codigo por
`normalizePersistedOrderProgressStep()`, mantendo o valor persistido original em
caso de auditoria.

## Leitura correta

Quando houver duvida entre estado de negocio e estado de conversa, o contrato
terminal da maquina prevalece para impedir retomada indevida de pedidos
encerrados.
