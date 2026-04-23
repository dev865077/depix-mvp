# Migracao TypeScript

## Lista curta de excecoes de runtime ainda existentes em `src/`

Nenhuma excecao de runtime permanece em `src/`.

## Observacao

A lista abaixo registra os arquivos que ainda estavam em JavaScript em fases anteriores da migracao, para manter o historico de referencia:

- `src/telegram/diagnostics.ts`
- `src/telegram/reply-flow.runtime.ts`
- `src/telegram/wallet-address.ts`

## Regra de manutencao

Se um novo arquivo JavaScript de runtime aparecer em `src/`, esta pagina deve ser atualizada na mesma PR.

## Historico

Os arquivos abaixo foram migrados para TypeScript e portanto nao devem mais aparecer como excecao de runtime:

- `src/services/telegram-order-confirmation.ts`
- `src/services/telegram-payment-notifications.ts`
- `src/services/telegram-webhook-ops.ts`
- `src/telegram/diagnostics.ts`
- `src/telegram/reply-flow.runtime.ts`
- `src/telegram/wallet-address.ts`
