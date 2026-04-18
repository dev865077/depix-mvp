# XState e Fluxo de Pedidos

## Papel do XState no MVP

`XState` e usado para tornar explicita a progressao valida de um pedido. Em vez
de cada handler decidir informalmente qual e o proximo passo, a aplicacao
converte entradas externas em eventos de dominio e deixa a maquina calcular a
transicao.

Esta pagina descreve a fundacao da progressao inicial. A conexao completa com
Telegram, criacao de deposito na Eulen e reconciliacao de webhook continua sendo
uma fatia funcional separada.

## Regra arquitetural

A maquina de pedidos deve permanecer pura:

- nao acessa `env`
- nao chama Telegram, Eulen ou Cloudflare APIs
- nao le nem escreve no D1
- nao guarda estado em memoria global do Worker
- recebe contexto de negocio e evento de dominio
- devolve `currentStep`, `status`, contexto atualizado e `orderPatch`
- devolve `persistenceGuard` para updates condicionais no D1

Essa regra combina com Cloudflare Workers porque o isolate pode ser reutilizado.
O estado real do fluxo deve ser persistido no D1 entre requests.

## Estados iniciais implementados

Estados atuais da progressao inicial:

1. `draft`
2. `amount`
3. `wallet`
4. `confirmation`
5. `creating_deposit`
6. `awaiting_payment`
7. `completed`
8. `failed`
9. `canceled`

`orders.current_step` guarda o estado da maquina. `orders.status` guarda o
status operacional derivado do estado.

## Eventos de dominio

Eventos atuais:

- `START_ORDER`
- `AMOUNT_RECEIVED`
- `WALLET_RECEIVED`
- `CUSTOMER_CONFIRMED`
- `DEPOSIT_CREATED`
- `PAYMENT_CONFIRMED`
- `FAIL_ORDER`
- `CANCEL_ORDER`

Handlers de transporte devem mapear mensagens, webhooks ou jobs para esses
eventos. A maquina nao deve receber payload bruto de Telegram, Hono ou Eulen.

## Integracao esperada com Cloudflare

Fluxo recomendado dentro do Worker:

1. `Hono` resolve ambiente e tenant.
2. O handler carrega o pedido atual no D1.
3. O handler monta um evento de dominio.
4. `advanceOrderProgression()` calcula a transicao.
5. O service persiste `orderPatch` no D1 usando `persistenceGuard`.
6. Side effects externos acontecem fora da maquina.

`persistenceGuard.expectedCurrentStep` deve entrar no `WHERE` do update junto
com `tenantId` e `orderId`. Isso evita que uma request atrasada sobrescreva uma
transicao mais nova do mesmo pedido.

O repositorio de pedidos expoe `updateOrderByIdWithStepGuard()` para aplicar
esse contrato no D1. Em caso de conflito, a funcao retorna `conflict: true` e o
pedido atual, sem sobrescrever a linha.

## Compatibilidade de dados

A maquina aceita somente estados canonicos conhecidos. Linhas ja existentes que
usem `draft`, `wallet`, `awaiting_payment` ou `completed` continuam dentro do
vocabulario atual. Qualquer valor legado fora dessa lista deve ser normalizado
por migracao ou tratado explicitamente antes de chamar `advanceOrderProgression()`.

Estados operacionais vindos do webhook da Eulen, como revisao manual, continuam
sob responsabilidade do service de webhook ate a integracao completa do fluxo.

Para Durable Objects, a regra muda apenas se houver necessidade real de
coordenacao stateful. No MVP, D1 continua sendo a fonte de verdade suficiente
para a progressao do pedido.

## Arquivos principais

- `src/order-flow/order-progress-machine.js`
- `test/order-progress-machine.test.js`
