# Migracao TypeScript

Esta pagina acompanha a migracao gradual do repositorio para TypeScript e lista as excecoes ainda existentes em JavaScript quando ha razao pratica para permanecerem assim.

## Estado atual

A migracao central continua em andamento, com o runtime, rotas centrais e contratos compartilhados ja consolidados em TypeScript nas areas principais do Worker.

## Lista curta de excecoes de runtime ainda existentes em `src/`

- `src/lib/background-tasks.js`
- `src/lib/logger.js`
- `src/middleware/request-context.js`
- `src/services/eulen-deposit-recheck.js`
- `src/services/eulen-deposits-fallback.js`
- `src/services/local-diagnostic-validation.js`
- `src/services/telegram-conversation-timeout.js`
- `src/telegram/bot.js`
- `src/telegram/errors.js`
- `src/telegram/runtime.js`
- `src/telegram/update-normalization.js`
- `src/telegram/update-router.js`
- `src/clients/eulen.js`
- `src/db/client.js`
- `src/db/repositories/background-tasks.js`
- `src/db/repositories/orders.js`
- `src/db/repositories/deposits.js`
- `src/db/repositories/deposit-events.js`

## Observacao

Os arquivos abaixo foram migrados para TypeScript e portanto nao devem mais aparecer na lista de excecoes:

- `src/config/runtime.ts`
- `src/config/tenants.ts`
- `src/order-flow/order-progress-constants.ts`

## Regra de manutencao

Sempre que um arquivo sair da lista de excecoes, a wiki deve ser atualizada na mesma PR para manter o inventario de JavaScript restante confiavel.
