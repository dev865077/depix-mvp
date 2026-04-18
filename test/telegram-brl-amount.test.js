import { describe, expect, it } from "vitest";

import {
  MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
  formatBrlAmountInCents,
  parseTelegramBrlAmount,
} from "../src/telegram/brl-amount.js";

describe("telegram BRL amount parser", () => {
  it.each([
    ["10", 1000],
    ["10,50", 1050],
    ["R$ 10,50", 1050],
    ["  R$ 1,00  ", 100],
  ])("accepts simple BRL amount %s", function assertAcceptedAmount(rawText, amountInCents) {
    expect(parseTelegramBrlAmount(rawText)).toEqual({
      ok: true,
      amountInCents,
    });
  });

  it.each([
    ["", "empty"],
    ["0", "non_positive"],
    ["-10", "invalid_format"],
    ["10,5", "invalid_format"],
    ["10.50", "invalid_format"],
    ["10 reais", "invalid_format"],
    ["R$ 10,501", "invalid_format"],
    ["10000,01", "above_limit"],
  ])("rejects unsafe or ambiguous BRL amount %s", function assertRejectedAmount(rawText, reason) {
    expect(parseTelegramBrlAmount(rawText)).toEqual({
      ok: false,
      reason,
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    });
  });

  it("formats BRL cents deterministically for Telegram copy", function assertBrlFormatting() {
    expect(formatBrlAmountInCents(0)).toBe("R$ 0,00");
    expect(formatBrlAmountInCents(1050)).toBe("R$ 10,50");
    expect(formatBrlAmountInCents(MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS)).toBe("R$ 10.000,00");
  });
});
