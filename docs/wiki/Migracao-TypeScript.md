# Migracao TypeScript

## Lista curta de excecoes de runtime ainda existentes em `src/`

- `src/telegram/diagnostics.js`
- `src/telegram/reply-flow.runtime.js`
- `src/telegram/wallet-address.js`

## Observacao

Os arquivos abaixo foram migrados para TypeScript e portanto nao devem mais aparecer na lista de excecoes:

- `src/config/runtime.ts`
- `src/config/tenants.ts`
- `src/lib/background-tasks.ts`
- `src/lib/logger.ts`
- `src/middleware/request-context.ts`
- `src/order-flow/order-progress-constants.ts`
- `src/services/eulen-deposit-recheck.ts`
- `src/services/eulen-deposits-fallback.ts`
- `src/services/local-diagnostic-validation.ts`
- `src/services/order-registration.ts`
- `src/services/scheduled-deposit-reconciliation.ts`
- `src/services/telegram-order-confirmation.ts`
- `src/services/telegram-payment-notifications.ts`
- `src/services/telegram-webhook-ops.ts`

## Regra de manutencao

Sempre que um arquivo sair da lista de excecoes, a wiki deve ser atualizada na mesma PR para manter o inventario de JavaScript restante confiavel.
