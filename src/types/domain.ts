export const PLATFORMS = ["telegram"] as const;

export const ORDER_STEPS = [
  "draft",
  "amount",
  "wallet",
  "confirmation",
  "creating_deposit",
  "awaiting_payment",
  "completed",
  "failed",
  "canceled",
  "manual_review",
] as const;

export const ORDER_STATUSES = [
  "draft",
  "processing",
  "pending",
  "paid",
  "failed",
  "canceled",
  "under_review",
] as const;

export type Platform = typeof PLATFORMS[number];
export type OrderStep = typeof ORDER_STEPS[number];
export type OrderStatus = typeof ORDER_STATUSES[number];

export type TenantId = string;
export type OrderId = string;
export type DepositEntryId = string;
