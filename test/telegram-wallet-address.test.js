import { describe, expect, it } from "vitest";

import { parseTelegramWalletAddress } from "../src/telegram/wallet-address.js";

const SIDESWAP_LQ_ADDRESS = "lq1qqt6tf80s4c8k5n5v88smk40d5cqh6wp63025cwypeemlh3ra84xgfng64m08lv69d9wau62vag5alxyvzv8hq8qqn9sjtr4pd";
const EX_ADDRESS = "ex1qhuq5u7udzwskhaz45fy80kdaxjytqd99ju5yfn";

describe("telegram wallet address parser", () => {
  it("accepts SideSwap lq1 addresses pasted as one string", function assertLqAddress() {
    expect(parseTelegramWalletAddress(SIDESWAP_LQ_ADDRESS)).toEqual({
      ok: true,
      walletAddress: SIDESWAP_LQ_ADDRESS,
    });
  });

  it("accepts ex1 addresses", function assertExAddress() {
    expect(parseTelegramWalletAddress(EX_ADDRESS)).toEqual({
      ok: true,
      walletAddress: EX_ADDRESS,
    });
  });

  it("normalizes visual spaces and line breaks before persistence", function assertWhitespaceNormalization() {
    const groupedAddress = [
      "lq1qqt6tf80s4c8k5n5v88smk40d5cqh6wp63025",
      "cwypeemlh3ra84xgfng64m08lv69d9wau62vag5al",
      "xyvzv8hq8qqn9sjtr4pd",
    ].join(" \n ");

    expect(parseTelegramWalletAddress(groupedAddress)).toEqual({
      ok: true,
      walletAddress: SIDESWAP_LQ_ADDRESS,
    });
  });

  it.each([
    ["", "empty"],
    ["liquidnetwork:lq1qqt6tf80s4c8k5n5v88smk40d5cqh6wp63025", "uri_not_supported"],
    ["bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "invalid_format"],
    [`${SIDESWAP_LQ_ADDRESS.slice(0, -1)}b`, "invalid_format"],
    ["lq1 curto", "invalid_format"],
    [`${SIDESWAP_LQ_ADDRESS} extra`, "invalid_format"],
    ["texto qualquer", "invalid_format"],
  ])("rejects unsupported wallet input %s", function assertInvalidWallet(rawText, reason) {
    expect(parseTelegramWalletAddress(rawText)).toEqual({
      ok: false,
      reason,
    });
  });
});
