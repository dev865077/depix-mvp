# DeBot Extraction Boundary

## Objetivo

Este documento fecha o inventario concreto exigido por `#696` para que `#673`
possa extrair o DeBot sem redescobrir fronteira durante a implementacao.

Destino fisico aprovado: `dev865077/DeBot`.

Regra central: DeBot recebe somente a superficie Telegram/order-flow. Eulen,
D1 financeiro, webhooks financeiros, reconciliacao financeira e lifecycle
financeiro ficam fora do DeBot.

## Entrypoints que entram no DeBot

### Webhook Telegram

- `src/routes/telegram.ts`
  - `telegramRouter.post("/:tenantId/webhook", createWebhookRateLimitMiddleware("telegram_webhook"), handleTelegramWebhook)`
  - `handleTelegramWebhook`
  - `buildTelegramPublicBaseUrl`
  - `shouldEnsureTelegramPublicSurface`

O path `/:tenantId/webhook` continua sendo o ingress multi-tenant do bot. A
montagem final do app pode mudar no repo DeBot, mas o contrato de entrada
continua path-scoped por tenant.

### Runtime do bot

- `src/telegram/runtime.ts`
  - `createTelegramBot`
  - `createTelegramRuntime`
  - `getTelegramRuntime`
  - `listBootstrappedTelegramTenants`
  - `clearTelegramRuntimeCache`
- `src/telegram/reply-flow.ts`
  - reexport do instalador de fluxo
- `src/telegram/reply-flow.runtime.ts`
  - `installTelegramReplyFlow`

### Handlers Telegram que entram no DeBot

O DeBot passa a ser dono dos handlers abaixo, hoje instalados em
`installTelegramReplyFlow`:

- middleware `attachTelegramContext`
- comando `/start`
- comando `/iniciar`
- comando `/help`
- comando `/status`
- comando `/cancel`
- callback query `depix:(buy|confirm|cancel|status|help)`
- handler generico `message:text` para:
  - reinicio de conversa
  - cancelamento por texto
  - captura de valor em BRL
  - captura de wallet DePix
  - confirmacao textual do pedido
  - resposta de etapa do order-flow
- handler `message` para mensagens sem texto
- fallback `routeUnsupportedTelegramUpdates`
- logger final de update sem handler selecionado
- `bot.catch` usado para normalizacao/log dos erros do runtime

## Modulos que entram no DeBot

### Superficie Telegram

- `src/telegram/brl-amount.ts`
- `src/telegram/diagnostics.ts`
- `src/telegram/errors.ts`
- `src/telegram/public-surface.ts`
- `src/telegram/raw-update.ts`
- `src/telegram/reply-flow.runtime.ts`
- `src/telegram/reply-flow.ts`
- `src/telegram/runtime.ts`
- `src/telegram/types.ts`
- `src/telegram/wallet-address.ts`

### Order-flow conversacional

- `src/order-flow/order-progress-constants.ts`
- `src/order-flow/order-progress-machine.ts`

### Services bot-owned

- `src/services/order-registration.ts`
- `src/services/telegram-canonical-message.ts`
- `src/services/telegram-conversation-timeout.ts`
- `src/services/telegram-webhook-ops.ts`

### Notificacao de canal

- `src/services/telegram-payment-notifications.ts`

Este modulo entra no ownership do DeBot somente como entrega de mensagem no
canal Telegram. A verdade financeira que dispara a notificacao continua sendo
responsabilidade da API financeira.

### Cliente de fronteira financeira

- `src/services/internal-financial-api.ts`

No repo DeBot, este modulo deve virar o cliente HTTP para a API financeira
definida em `docs/financial-api-boundary.md`. Ele nao pode carregar a
implementacao financeira junto com o bot.

## Rotas operacionais que entram parcialmente

`src/routes/ops.ts` mistura operacoes financeiras e Telegram. Somente estas
rotas pertencem ao DeBot:

- `GET /:tenantId/telegram/webhook-info`
  - `handleTelegramWebhookInfo`
- `POST /:tenantId/telegram/register-webhook`
  - `handleTelegramWebhookRegistration`
- helper `handleTelegramWebhookOpsRouteError`

As rotas abaixo ficam fora do DeBot:

- `POST /:tenantId/recheck/deposit`
- `POST /:tenantId/reconcile/deposits`
- `GET /:tenantId/eulen/ping`
- `POST /:tenantId/eulen/create-deposit`

## Suporte compartilhado permitido

O DeBot pode copiar ou recriar o minimo necessario destes modulos, desde que
sem trazer D1 financeiro nem Eulen:

- `src/config/runtime.ts`
- `src/config/tenants.ts`
- `src/lib/background-tasks.ts`
- `src/lib/http.ts`
- `src/lib/logger.ts`
- `src/middleware/request-context.ts`
- `src/middleware/webhook-rate-limit.ts`
- `src/types/runtime.ts`

Tipos de persistencia podem entrar apenas como DTOs de projecao bot-facing. O
DeBot nao deve importar o modelo D1 completo como contrato permanente.

## Acoplamentos transitorios a remover antes ou durante #673

Estes pontos existem hoje no monolito e nao podem ser preservados como
arquitetura final do DeBot:

- `src/telegram/reply-flow.runtime.ts` ainda importa
  `src/db/repositories/deposits-repository.ts` para status de deposito.
- `src/telegram/reply-flow.runtime.ts` ainda importa
  `TelegramOrderConfirmationError` de
  `src/services/telegram-order-confirmation.ts`.
- `src/services/order-registration.ts` ainda persiste pedidos via
  `src/db/repositories/orders-repository.ts`.
- `src/services/telegram-canonical-message.ts` ainda atualiza pedido via
  `src/db/repositories/orders-repository.ts`.
- `src/services/telegram-payment-notifications.ts` ainda le repositorios D1
  para montar notificacao.
- `src/services/internal-financial-api.ts` ainda chama implementacoes locais:
  `telegram-order-confirmation`, `eulen-deposit-recheck`,
  `deposits-repository` e `orders-repository`.
- `src/routes/telegram.ts` ainda recebe `db` do monolito e repassa para o
  runtime.

Tratamento esperado: `#668` e `#673` devem substituir esses acessos por chamadas
ao contrato da API financeira ou por projecoes bot-owned. Nao e permitido mover
os repositorios D1 financeiros para dentro do DeBot para "resolver" esses
imports.

## Ficam fora do DeBot

### Financeiro, Eulen e D1

- `src/clients/eulen-client.ts`
- `src/routes/webhooks.ts`
- `src/services/eulen-deposit-recheck.ts`
- `src/services/eulen-deposit-webhook.ts`
- `src/services/eulen-deposits-fallback.ts`
- `src/services/scheduled-deposit-reconciliation.ts`
- `src/services/telegram-order-confirmation.ts`
- `src/services/telegram-order-nonce.ts`
- `src/db/**`
- `migrations/**`

### Rotas ops financeiras

- fallback operacional de depositos
- recheck operacional de deposito
- diagnosticos Eulen
- autorizacao ou regras de lifecycle financeiro

### Implementacao da API financeira

Tudo que implementa o contrato de `docs/financial-api-boundary.md` pertence ao
repo da API financeira (`Sagui`), nao ao DeBot. O DeBot consome o contrato; ele
nao hospeda a regra financeira.

## Testes que acompanham o corte inicial

Estes testes formam a base de smoke/regressao para o DeBot, com mocks da API
financeira quando houver estado de pagamento:

- `test/telegram-brl-amount.test.js`
- `test/telegram-raw-update.test.js`
- `test/telegram-real-flow.test.ts`
- `test/telegram-runtime.test.js`
- `test/telegram-wallet-address.test.js`
- `test/telegram-webhook-reply.test.js`
- `test/order-progress-machine-runtime-import.test.js`
- `test/order-progress-machine.test.js`
- `test/order-registration.test.js`
- `test/ops-telegram-webhook.test.js`
- `test/internal-financial-api.test.ts`
- parte Telegram de `test/tenant-routing.test.js`
- parte de canal de `test/telegram-payment-notifications.test.js`

Testes de Eulen, webhook financeiro, repositorios D1 financeiros e reconciliacao
financeira ficam com a API financeira.

## Artefatos minimos esperados no repo DeBot

`#673` deve deixar `dev865077/DeBot` com:

- `README.md` declarando que o repo contem somente Telegram/order-flow.
- `docs/ownership.md` com a lista de entrada e exclusao deste documento.
- smoke executavel que sobe a superficie do bot sem Eulen e sem D1 financeiro.
- mocks ou fixtures da API financeira para os caminhos de pagamento.

Smoke minimo aceito:

1. carregar o runtime Telegram;
2. registrar webhook/info de tenant com segredo fake;
3. processar um update `/start` ou texto de conversa;
4. responder sem acessar Eulen, D1 financeiro ou lifecycle financeiro.

## Handoff para #673

`#673` deve consumir este documento como lista fechada. Qualquer modulo fora da
secao "Modulos que entram no DeBot" precisa de nova issue de boundary antes de
ser movido.

O primeiro commit de extracao no repo DeBot deve referenciar este documento e
preservar a regra: DeBot conversa com a API financeira; DeBot nao vira a API
financeira.
