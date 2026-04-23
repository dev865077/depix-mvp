# Financial API Boundary

## Objective

This document defines the target contract between `debot` and the future financial API before the physical repository split. It is intentionally grounded in the current monolith so `#668`, `#672`, and `#673` can move without redefining ownership during implementation.

Current monolith evidence:

- Bot payment creation still calls Eulen directly in `src/services/telegram-order-confirmation.ts`.
- Bot pending-payment status still triggers direct reconciliation in `src/telegram/reply-flow.runtime.ts`.
- The financial surface already exists as external webhook plus operational reconciliation routes in `src/routes/webhooks.ts` and `src/routes/ops.ts`.

## Boundary Rule

After the split:

- `debot` owns conversation, commands, prompts, Telegram-specific reply formatting, and when to ask for payment state.
- `api` owns Eulen credentials, split config materialization, D1 financial persistence, webhook verification, idempotency, payment state transitions, and operational reconciliation.
- `debot` must not call Eulen directly.
- `debot` must not read or write D1 financial rows directly.
- External Eulen webhooks terminate in `api`, not in `debot`.

## Tenant, Auth, and Correlation Rules

### Tenant resolution

- `tenantId` is path-scoped and authoritative for the target aggregate.
- `partnerId`, split config, and Eulen credentials are resolved inside the financial API from tenant configuration.
- `debot` may send business identifiers such as `orderId` and `correlationId`, but not tenant secrets or split values.

### Auth

| Caller | Contract | Auth |
| --- | --- | --- |
| `debot` -> financial API | internal service-to-service calls | `Authorization: Bearer <DEBOT_INTERNAL_API_TOKEN>` |
| Eulen -> financial API | external deposit webhook | `Authorization: Basic <tenant webhook secret>` |
| operator -> financial API | operational reconciliation | `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>` |

### Correlation headers

- `X-Request-Id`: end-to-end request correlation across bot, API, and webhook handling.
- `Idempotency-Key`: mandatory on payment creation from `debot`.
- `X-Correlation-Id`: stable order/business correlation. In the current monolith this is already persisted with the order aggregate.

## Target Endpoint Matrix

These are the contract endpoints that `debot` and operations should rely on after the boundary is introduced.

| Method | Path | Consumer | Purpose | Request | Response | Stable error codes |
| --- | --- | --- | --- | --- | --- | --- |
| `POST` | `/financial-api/v1/tenants/{tenantId}/payments` | `debot` | Create or resume the payable financial aggregate for one order. This replaces direct Eulen deposit creation from the Telegram runtime. | JSON with `orderId`, `correlationId`, `amountInCents`, `walletAddress`, `channel`, optional `resumeIfExists`. Requires `Idempotency-Key`. | `200` or `201` with materialized payment state, including `depositEntryId`, `qrId`, `qrCopyPaste`, `qrImageUrl`, `externalStatus`, `orderStatus`, `orderCurrentStep`, `expiration`, `duplicate`. | `tenant_not_resolved`, `payment_payload_invalid`, `payment_idempotency_key_required`, `payment_order_not_payable`, `payment_dependency_unavailable`, `payment_upstream_failed` |
| `GET` | `/financial-api/v1/tenants/{tenantId}/payments/{depositEntryId}` | `debot` | Read the current materialized payment state without forcing reconciliation. | Path param `depositEntryId`. Optional `orderId` query allowed only for consistency checks. | `200` with current payment/order projection. | `tenant_not_resolved`, `payment_not_found` |
| `POST` | `/financial-api/v1/tenants/{tenantId}/payments/{depositEntryId}/reconcile` | `debot` | Refresh the materialized payment state from Eulen for an order that is still awaiting payment. This is the bot-safe replacement for direct `deposit-status` calls. | JSON with `orderId`, optional `reason` (`status_poll`, `start_resume`, `manual_repair`). | `200` with updated payment/order projection and `source: "recheck_deposit_status"` when reconciliation ran. | `tenant_not_resolved`, `payment_not_found`, `payment_reconcile_not_allowed`, `recheck_dependency_unavailable`, `deposit_status_regression` |
| `POST` | `/financial-api/v1/webhooks/eulen/{tenantId}/deposit` | Eulen | Receive the canonical payment webhook from Eulen, validate auth, deduplicate delivery, and apply financial truth. | Raw Eulen webhook payload with `qrId`, `status`, `bankTxId`, `blockchainTxId`. | `200` with `ok`, `tenantId`, `depositEntryId`, `qrId`, `externalStatus`, `duplicate`. | `tenant_not_resolved`, `invalid_webhook_payload`, `webhook_dependency_unavailable`, `webhook_unauthorized`, `deposit_correlation_failed` |
| `POST` | `/financial-api/v1/tenants/{tenantId}/ops/reconcile/deposits` | operator | Reconcile a bounded time window through Eulen `/deposits` for operational recovery. | JSON with `start`, `end`, optional `status`. | `200` with `results[]`, `duplicate` markers, and updated aggregate evidence. | `tenant_not_resolved`, `ops_route_unauthorized`, `deposits_fallback_invalid_window`, `deposits_fallback_window_too_large`, `deposits_fallback_dependency_unavailable` |

## Payment Projection Returned To DeBot

The bot-facing contract should return the same projection shape from create, read, and reconcile so `debot` can stay transport-focused.

```json
{
  "ok": true,
  "tenantId": "alpha",
  "orderId": "order_alpha_001",
  "correlationId": "corr_alpha_001",
  "depositEntryId": "deposit_entry_alpha_001",
  "qrId": "qr_alpha_001",
  "qrCopyPaste": "0002010102122688qr-alpha-001",
  "qrImageUrl": "https://example.com/qr/alpha.png",
  "externalStatus": "pending",
  "orderStatus": "pending",
  "orderCurrentStep": "awaiting_payment",
  "expiration": "2026-04-18T04:00:00Z",
  "duplicate": false
}
```

## Request Examples

### 1. Create or resume payment from DeBot

```http
POST /financial-api/v1/tenants/alpha/payments
Authorization: Bearer <DEBOT_INTERNAL_API_TOKEN>
Idempotency-Key: 2fc8b2ab-b641-4ddf-97a7-fd58ca6394b2
X-Request-Id: req_01
X-Correlation-Id: corr_alpha_001
Content-Type: application/json
```

```json
{
  "orderId": "order_alpha_001",
  "correlationId": "corr_alpha_001",
  "channel": "telegram",
  "amountInCents": 12345,
  "walletAddress": "depix_wallet_alpha",
  "resumeIfExists": true
}
```

Expected semantics:

- API resolves tenant split config and Eulen credentials internally.
- API creates the Eulen deposit or returns the already-materialized payable deposit.
- API persists financial state before returning.
- API returns the full payment projection shown above.

### 2. Bot-triggered bounded reconciliation

```http
POST /financial-api/v1/tenants/alpha/payments/deposit_entry_alpha_001/reconcile
Authorization: Bearer <DEBOT_INTERNAL_API_TOKEN>
X-Request-Id: req_02
X-Correlation-Id: corr_alpha_001
Content-Type: application/json
```

```json
{
  "orderId": "order_alpha_001",
  "reason": "status_poll"
}
```

Expected semantics:

- Allowed only while the payment is still operationally reconcilable.
- API calls Eulen `deposit-status`, applies non-regressive state transitions, and records a reconciliation event.
- Bot receives a refreshed payment projection and decides how to render it.

### 3. Eulen webhook

```http
POST /financial-api/v1/webhooks/eulen/alpha/deposit
Authorization: Basic alpha-eulen-secret
Content-Type: application/json
```

```json
{
  "webhookType": "deposit",
  "qrId": "qr_alpha_001",
  "status": "depix_sent",
  "bankTxId": "bank_tx_alpha_001",
  "blockchainTxID": "blockchain_tx_alpha_001"
}
```

Expected semantics:

- API validates webhook auth against tenant-configured secret.
- API correlates `qrId` to `depositEntryId`, persists the audit event, and updates order/deposit truth.
- Any Telegram notification is downstream of the financial state change and must not be required to succeed for the webhook itself to succeed.

## Idempotency and Dedup Rules

### Payment creation

- `debot` must send `Idempotency-Key`.
- The API treats `tenantId + orderId + Idempotency-Key` as the creation dedup boundary.
- Replays must return the existing materialized payable deposit instead of creating a second upstream deposit.
- The current monolith already enforces single-winner behavior around payment creation in the Telegram confirmation service.

### Webhook delivery

- Webhook redelivery is deduplicated at the financial event layer.
- Duplicate webhook deliveries must not send the aggregate backward or create duplicate visible transitions.

### Reconcile and fallback

- Bot-triggered reconcile and operator fallback are safe to retry.
- They may create a new reconciliation audit event only when the remote truth materially differs and the event boundary is not already present.
- They must not regress a locally completed aggregate to a lower remote state.

## Ownership Matrix

| Concern | Owner | Notes |
| --- | --- | --- |
| Telegram commands, copy, callback routing, UI decisions | `debot` | Includes `/start`, `/help`, `/status`, `/cancel`, and how the QR or final receipt is presented. |
| Eulen credentials, split config, partner id | financial API | Resolved from tenant config and secrets. Never sent from `debot`. |
| Deposit creation, deposit status polling, `/deposits` fallback | financial API | `debot` can request these behaviors only through the contract endpoints above. |
| Webhook auth verification and payload validation | financial API | External Eulen surface terminates here. |
| Financial aggregate persistence in D1 | financial API | Orders/deposits/deposit-events remain API-owned after the split. |
| Notification side effects after payment truth changes | `debot`, triggered by API-owned state transitions | The financial API owns the state change; `debot` owns the user-facing channel delivery. |
| Retry policy for Eulen calls | financial API | Includes timeout, retry, async mode, and failure mapping. |
| Rollback of bot UX if payment refresh fails | `debot` | Bot decides fallback messaging, but not payment truth. |

## Current Monolith Validation

The contract above is not speculative. It is anchored to the current runtime:

1. Bot-side payment creation currently lives in `confirmTelegramOrder`, which still reads tenant Eulen secrets and calls `createEulenDeposit`.
2. Bot-side pending payment refresh currently reuses `processDepositRecheck` directly from the Telegram runtime.
3. Financial truth already enters through the canonical Eulen webhook route and operational reconciliation routes.
4. The acceptance path for the split is therefore:
   - define this contract,
   - move the bot to this boundary,
   - then extract the physical API and DeBot repositories.

## Implementation Notes For #668 And #672

- `#668` should replace direct calls from `debot` to `confirmTelegramOrder` and `processDepositRecheck` with calls to the contract endpoints in this document.
- `#672` should preserve the externally visible webhook and ops semantics while moving the implementation into the dedicated API repository.
- During transition, fallback to the current path is acceptable only where the issue explicitly requires it and only behind the boundary cutover logic.
