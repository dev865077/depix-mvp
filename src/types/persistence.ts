import type { DepositEntryId, OrderId, OrderStatus, OrderStep, Platform, TenantId } from "./domain.js";

export type PersistenceTimestamp = string;
export type DepositQrId = string;
export type DepositNonce = string;
export type DepositExternalStatus = string;
export type DepositEventSource = string;
export type DepositEventId = number;

export interface OrderRecord {
  tenantId: TenantId;
  orderId: OrderId;
  userId: string;
  channel: Platform;
  productType: string;
  telegramChatId: string | null;
  telegramCanonicalMessageId: number | null;
  telegramCanonicalMessageKind: string | null;
  amountInCents: number | null;
  walletAddress: string | null;
  currentStep: OrderStep;
  status: OrderStatus;
  splitAddress: string | null;
  splitFee: string | null;
  createdAt: PersistenceTimestamp;
  updatedAt: PersistenceTimestamp;
}

export interface CreateOrderInput {
  tenantId: TenantId;
  orderId: OrderId;
  userId: string;
  channel?: Platform;
  productType: string;
  telegramChatId?: string | null;
  telegramCanonicalMessageId?: number | null;
  telegramCanonicalMessageKind?: string | null;
  amountInCents?: number | null;
  walletAddress?: string | null;
  currentStep?: OrderStep;
  status?: OrderStatus;
  splitAddress?: string | null;
  splitFee?: string | null;
}

export interface OrderPatch {
  tenantId?: TenantId;
  userId?: string;
  channel?: Platform;
  productType?: string;
  telegramChatId?: string | null;
  telegramCanonicalMessageId?: number | null;
  telegramCanonicalMessageKind?: string | null;
  amountInCents?: number | null;
  walletAddress?: string | null;
  currentStep?: OrderStep;
  status?: OrderStatus;
  splitAddress?: string | null;
  splitFee?: string | null;
}

export interface HydrateOrderTelegramChatInput {
  tenantId: TenantId;
  orderId: OrderId;
  userId: string;
  channel: Platform;
  telegramChatId: string;
}

export type HydrateOrderTelegramChatReason =
  | "updated"
  | "not_found"
  | "already_bound_or_identity_mismatch";

export interface HydrateOrderTelegramChatResult {
  order: OrderRecord | null;
  didUpdate: boolean;
  notFound: boolean;
  reason: HydrateOrderTelegramChatReason;
}

export type UpdateOrderWithStepGuardReason =
  | "updated"
  | "empty_patch"
  | "step_conflict"
  | "not_found";

export interface UpdateOrderWithStepGuardResult {
  order: OrderRecord | null;
  didUpdate: boolean;
  conflict: boolean;
  notFound: boolean;
  reason: UpdateOrderWithStepGuardReason;
}

export interface DepositRecord {
  tenantId: TenantId;
  depositEntryId: DepositEntryId;
  qrId: DepositQrId | null;
  orderId: OrderId;
  nonce: DepositNonce;
  createdRequestId: string | null;
  qrCopyPaste: string;
  qrImageUrl: string;
  externalStatus: DepositExternalStatus;
  expiration: PersistenceTimestamp | null;
  createdAt: PersistenceTimestamp;
  updatedAt: PersistenceTimestamp;
}

export interface CreateDepositInput {
  tenantId: TenantId;
  depositEntryId: DepositEntryId;
  qrId?: DepositQrId | null;
  orderId: OrderId;
  nonce: DepositNonce;
  createdRequestId?: string | null;
  qrCopyPaste: string;
  qrImageUrl: string;
  externalStatus?: DepositExternalStatus;
  expiration?: PersistenceTimestamp | null;
}

export interface DepositPatch {
  tenantId?: TenantId;
  qrId?: DepositQrId | null;
  orderId?: OrderId;
  nonce?: DepositNonce;
  createdRequestId?: string | null;
  qrCopyPaste?: string;
  qrImageUrl?: string;
  externalStatus?: DepositExternalStatus;
  expiration?: PersistenceTimestamp | null;
}

export interface DepositEventRecord {
  id: DepositEventId;
  tenantId: TenantId;
  orderId: OrderId;
  depositEntryId: DepositEntryId;
  qrId: DepositQrId | null;
  source: DepositEventSource;
  externalStatus: DepositExternalStatus;
  bankTxId: string | null;
  blockchainTxId: string | null;
  requestId: string | null;
  rawPayload: string;
  receivedAt: PersistenceTimestamp;
}

export interface CreateDepositEventInput {
  tenantId: TenantId;
  orderId: OrderId;
  depositEntryId: DepositEntryId;
  qrId?: DepositQrId | null;
  source: DepositEventSource;
  externalStatus: DepositExternalStatus;
  bankTxId?: string | null;
  blockchainTxId?: string | null;
  requestId?: string | null;
  rawPayload: string;
}
