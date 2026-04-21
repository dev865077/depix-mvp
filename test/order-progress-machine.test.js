/**
 * Testes da maquina XState de pedidos.
 *
 * O objetivo aqui e validar o contrato de dominio, nao o transporte. Por isso
 * os testes chamam a boundary pura (`advanceOrderProgression`) sem Telegram,
 * Hono, D1 ou bindings da Cloudflare.
 */
import { describe, expect, it } from "vitest";

import {
  ORDER_PROGRESS_EVENTS,
  ORDER_PROGRESS_STATES,
  OrderProgressionError,
  advanceOrderProgression,
  createInitialOrderProgression,
  normalizePersistedOrderProgressStep,
} from "../src/order-flow/order-progress-machine.ts";

const BASE_CONTEXT = {
  tenantId: "alpha",
  orderId: "order_001",
  userId: "telegram_user_001",
};

function advance(currentStep, event, context = BASE_CONTEXT) {
  return advanceOrderProgression({
    currentStep,
    context,
    event,
  });
}

describe("order progress machine", () => {
  it("creates a tenant-aware initial draft snapshot", () => {
    const result = createInitialOrderProgression(BASE_CONTEXT);

    expect(result.currentStep).toBe(ORDER_PROGRESS_STATES.DRAFT);
    expect(result.status).toBe("draft");
    expect(result.context.tenantId).toBe("alpha");
    expect(result.persistenceGuard).toEqual({
      tenantId: "alpha",
      orderId: "order_001",
      expectedCurrentStep: null,
    });
    expect(result.orderPatch).toEqual({
      currentStep: ORDER_PROGRESS_STATES.DRAFT,
      status: "draft",
    });
  });

  it("models the initial happy path from draft to completed", () => {
    const started = advance(ORDER_PROGRESS_STATES.DRAFT, {
      type: ORDER_PROGRESS_EVENTS.START_ORDER,
    });
    const amountReceived = advance(started.currentStep, {
      type: ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED,
      amountInCents: 15000,
    });
    const walletReceived = advance(
      amountReceived.currentStep,
      {
        type: ORDER_PROGRESS_EVENTS.WALLET_RECEIVED,
        walletAddress: "  lq1qqexample  ",
      },
      amountReceived.context,
    );
    const confirmed = advance(
      walletReceived.currentStep,
      {
        type: ORDER_PROGRESS_EVENTS.CUSTOMER_CONFIRMED,
      },
      walletReceived.context,
    );
    const depositCreated = advance(
      confirmed.currentStep,
      {
        type: ORDER_PROGRESS_EVENTS.DEPOSIT_CREATED,
        depositEntryId: "deposit_entry_001",
        qrId: "qr_001",
      },
      confirmed.context,
    );
    const paid = advance(
      depositCreated.currentStep,
      {
        type: ORDER_PROGRESS_EVENTS.PAYMENT_CONFIRMED,
      },
      depositCreated.context,
    );

    expect(started.currentStep).toBe(ORDER_PROGRESS_STATES.AMOUNT);
    expect(amountReceived.currentStep).toBe(ORDER_PROGRESS_STATES.WALLET);
    expect(amountReceived.orderPatch).toMatchObject({
      currentStep: ORDER_PROGRESS_STATES.WALLET,
      status: "draft",
      amountInCents: 15000,
    });
    expect(walletReceived.currentStep).toBe(ORDER_PROGRESS_STATES.CONFIRMATION);
    expect(walletReceived.context.walletAddress).toBe("lq1qqexample");
    expect(confirmed.currentStep).toBe(ORDER_PROGRESS_STATES.CREATING_DEPOSIT);
    expect(confirmed.status).toBe("processing");
    expect(depositCreated.currentStep).toBe(ORDER_PROGRESS_STATES.AWAITING_PAYMENT);
    expect(depositCreated.status).toBe("pending");
    expect(depositCreated.context.depositEntryId).toBe("deposit_entry_001");
    expect(depositCreated.context.qrId).toBe("qr_001");
    expect(paid.currentStep).toBe(ORDER_PROGRESS_STATES.COMPLETED);
    expect(paid.orderPatch).toMatchObject({
      currentStep: ORDER_PROGRESS_STATES.COMPLETED,
      status: "paid",
    });
  });

  it("returns a persistence guard for compare-and-set D1 updates", () => {
    const result = advance(ORDER_PROGRESS_STATES.AMOUNT, {
      type: ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED,
      amountInCents: 15000,
    });

    expect(result.persistenceGuard).toEqual({
      tenantId: "alpha",
      orderId: "order_001",
      expectedCurrentStep: ORDER_PROGRESS_STATES.AMOUNT,
    });
    expect(Object.keys(result.orderPatch).sort()).toEqual(["amountInCents", "currentStep", "status"]);
  });

  it("rejects invalid transitions instead of silently changing steps", () => {
    expect(() =>
      advance(ORDER_PROGRESS_STATES.DRAFT, {
        type: ORDER_PROGRESS_EVENTS.PAYMENT_CONFIRMED,
      }),
    ).toThrow(OrderProgressionError);
  });

  it("rejects malformed amount and wallet events", () => {
    expect(() =>
      advance(ORDER_PROGRESS_STATES.AMOUNT, {
        type: ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED,
        amountInCents: 0,
      }),
    ).toThrow(/Cannot apply/);

    expect(() =>
      advance(ORDER_PROGRESS_STATES.WALLET, {
        type: ORDER_PROGRESS_EVENTS.WALLET_RECEIVED,
        walletAddress: "   ",
      }),
    ).toThrow(/Cannot apply/);
  });

  it("prevents cross-tenant event application", () => {
    expect(() =>
      advance(ORDER_PROGRESS_STATES.DRAFT, {
        type: ORDER_PROGRESS_EVENTS.START_ORDER,
        tenantId: "beta",
      }),
    ).toThrow(/tenantId does not match/);
  });

  it("rejects duplicate and terminal events", () => {
    expect(() =>
      advance(ORDER_PROGRESS_STATES.WALLET, {
        type: ORDER_PROGRESS_EVENTS.AMOUNT_RECEIVED,
        amountInCents: 15000,
      }),
    ).toThrow(/Cannot apply/);

    expect(() =>
      advance(ORDER_PROGRESS_STATES.AWAITING_PAYMENT, {
        type: ORDER_PROGRESS_EVENTS.DEPOSIT_CREATED,
        depositEntryId: "deposit_entry_001",
      }),
    ).toThrow(/Cannot apply/);

    expect(() =>
      advance(ORDER_PROGRESS_STATES.COMPLETED, {
        type: ORDER_PROGRESS_EVENTS.PAYMENT_CONFIRMED,
      }),
    ).toThrow(/Cannot apply/);
  });

  it("normalizes known legacy steps while keeping persistence guard on the stored value", () => {
    const result = advance("awaiting_wallet", {
      type: ORDER_PROGRESS_EVENTS.WALLET_RECEIVED,
      walletAddress: "lq1qqexample",
    });

    expect(normalizePersistedOrderProgressStep("awaiting_wallet")).toBe(ORDER_PROGRESS_STATES.WALLET);
    expect(result.currentStep).toBe(ORDER_PROGRESS_STATES.CONFIRMATION);
    expect(result.persistenceGuard.expectedCurrentStep).toBe("awaiting_wallet");
  });

  it("supports explicit cancellation and failure terminal states", () => {
    const canceled = advance(ORDER_PROGRESS_STATES.WALLET, {
      type: ORDER_PROGRESS_EVENTS.CANCEL_ORDER,
    });
    const failed = advance(ORDER_PROGRESS_STATES.CREATING_DEPOSIT, {
      type: ORDER_PROGRESS_EVENTS.FAIL_ORDER,
      reason: "eulen_timeout",
    });

    expect(canceled.currentStep).toBe(ORDER_PROGRESS_STATES.CANCELED);
    expect(canceled.status).toBe("canceled");
    expect(failed.currentStep).toBe(ORDER_PROGRESS_STATES.FAILED);
    expect(failed.status).toBe("failed");
    expect(failed.context.failureReason).toBe("eulen_timeout");
  });
});
