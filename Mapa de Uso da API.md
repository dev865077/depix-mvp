
## Selecionado no MVP

- [x] Authentication
- [x] Ping
- [x] Nonce
- [x] Sync / Async call
- [x] Deposit
- [x] DepositResponse
- [x] DepositObj
- [x] Webhook de depósito
- [x] Deposit Status
- [x] Deposits
- [x] Deposit Statuses
- [x] depixAddress
- [x] depixSplitAddress
- [x] splitFee

## Uso atual no codigo

- `deposit`: criacao da cobranca principal
- `deposit-status`: recheck operacional por `depositEntryId` e correlacao segura de `qrId`
- `deposits`: fallback operacional por janela em `POST /ops/:tenantId/reconcile/deposits`, reconciliando linhas compactas por `qrId`

## Disponível na API e não selecionado

- [ ] Pix2FA
- [ ] Pix Messaging
- [ ] QR Delay
- [ ] User Info
- [ ] Withdraw
