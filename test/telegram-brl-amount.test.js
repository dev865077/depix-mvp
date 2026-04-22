import { describe, expect, it } from "vitest";

import {
  MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
  MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
  formatBrlAmountInCents,
  parseTelegramBrlAmount,
} from "../src/telegram/brl-amount.js";

describe("telegram BRL amount parser", () => {
  it.each([
    ["10", 1000],
    ["R$ 10", 1000],
    ["  R$ 3  ", 300],
  ])("accepts simple BRL amount %s", function assertAcceptedAmount(rawText, amountInCents) {
    expect(parseTelegramBrlAmount(rawText)).toEqual({
      ok: true,
      amountInCents,
    });
  });

  it.each([
    ["", "empty"],
    ["0", "below_minimum"],
    ["1", "below_minimum"],
    ["2", "below_minimum"],
    ["10,50", "cents_not_supported"],
    ["R$ 10,50", "cents_not_supported"],
    ["-10", "invalid_format"],
    ["10,5", "cents_not_supported"],
    ["10.50", "invalid_format"],
    ["10 reais", "invalid_format"],
    ["R$ 10,501", "cents_not_supported"],
    ["10001", "above_limit"],
  ])("rejects unsafe or ambiguous BRL amount %s", function assertRejectedAmount(rawText, reason) {
    expect(parseTelegramBrlAmount(rawText)).toEqual({
      ok: false,
      reason,
      minAmountInCents: MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    });
  });

  it("formats whole BRL amounts deterministically for Telegram copy", function assertBrlFormatting() {
    expect(formatBrlAmountInCents(0)).toBe("R$ 0");
    expect(formatBrlAmountInCents(MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS)).toBe("R$ 3");
    expect(formatBrlAmountInCents(1000)).toBe("R$ 10");
    expect(formatBrlAmountInCents(MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS)).toBe("R$ 10.000");
  });
});
