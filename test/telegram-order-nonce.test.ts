import { describe, expect, it } from "vitest";

import { createTelegramOrderDepositNonce } from "../src/services/telegram-order-nonce.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("telegram order deposit nonce", () => {
  it("reuses the UUID embedded in runtime order ids for Eulen X-Nonce", () => {
    expect(createTelegramOrderDepositNonce({
      tenantId: "alpha",
      orderId: "order_ee71f413-36bb-41ec-b212-b4090e16f0e3",
    })).toBe("ee71f413-36bb-41ec-b212-b4090e16f0e3");
  });

  it("keeps legacy non-UUID order ids stable while still returning a UUID", () => {
    const firstNonce = createTelegramOrderDepositNonce({
      tenantId: "alpha",
      orderId: "order_partial_recovery",
    });
    const secondNonce = createTelegramOrderDepositNonce({
      tenantId: "alpha",
      orderId: "order_partial_recovery",
    });
    const otherTenantNonce = createTelegramOrderDepositNonce({
      tenantId: "beta",
      orderId: "order_partial_recovery",
    });

    expect(firstNonce).toMatch(UUID_PATTERN);
    expect(firstNonce).toBe(secondNonce);
    expect(firstNonce).not.toBe(otherTenantNonce);
  });
});

