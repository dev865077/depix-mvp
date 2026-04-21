import type { D1Database } from "@cloudflare/workers-types";

import { cancelTelegramOpenOrder, getTelegramOpenOrderForUser } from "./order-registration.js";

const TIMEOUT_ELIGIBLE_STEPS = new Set([
  "amount",
  "wallet",
  "confirmation",
]);

export const DEFAULT_TELEGRAM_OPEN_ORDER_TIMEOUT_MINUTES = 30;

export function readTelegramOpenOrderTimeoutMinutes(value: unknown): number {
  if (typeof value === "undefined") {
    return DEFAULT_TELEGRAM_OPEN_ORDER_TIMEOUT_MINUTES;
  }

  const parsedValue = Number.parseInt(String(value).trim(), 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error("Invalid positive integer binding: TELEGRAM_OPEN_ORDER_TIMEOUT_MINUTES");
  }

  return parsedValue;
}

export function isTelegramOrderTimeoutEligible(order: { currentStep?: unknown } | null | undefined): boolean {
  return typeof order?.currentStep === "string" && TIMEOUT_ELIGIBLE_STEPS.has(order.currentStep);
}

export function isTelegramOpenOrderTimedOut(
  order: { currentStep?: unknown, updatedAt?: unknown } | null | undefined,
  timeoutMinutes: number,
  now = new Date(),
): boolean {
  if (!isTelegramOrderTimeoutEligible(order) || typeof order?.updatedAt !== "string") {
    return false;
  }

  const updatedAtTime = Date.parse(order.updatedAt);

  if (!Number.isFinite(updatedAtTime)) {
    return false;
  }

  return now.getTime() - updatedAtTime >= timeoutMinutes * 60 * 1000;
}

export async function expireTelegramOpenOrderIfTimedOut(input: {
  db: D1Database,
  tenant: { tenantId: string },
  telegramUserId: string | number,
  channel?: string,
  timeoutMinutes: number,
  now?: Date,
}): Promise<{
  openOrder: Record<string, unknown> | null,
  timedOut: boolean,
  cancellationAccepted: boolean,
  cancellationConflict: boolean,
  canceledOrder: Record<string, unknown> | null,
}> {
  const openOrder = await getTelegramOpenOrderForUser({
    db: input.db,
    tenant: input.tenant,
    telegramUserId: input.telegramUserId,
    channel: input.channel,
  });

  if (!isTelegramOpenOrderTimedOut(openOrder, input.timeoutMinutes, input.now)) {
    return {
      openOrder,
      timedOut: false,
      cancellationAccepted: false,
      cancellationConflict: false,
      canceledOrder: null,
    };
  }

  if (!openOrder) {
    return {
      openOrder: null,
      timedOut: false,
      cancellationAccepted: false,
      cancellationConflict: false,
      canceledOrder: null,
    };
  }

  const cancellation = await cancelTelegramOpenOrder({
    db: input.db,
    tenant: input.tenant,
    order: openOrder,
  });

  return {
    openOrder,
    timedOut: cancellation.accepted,
    cancellationAccepted: cancellation.accepted,
    cancellationConflict: cancellation.conflict,
    canceledOrder: cancellation.order,
  };
}
