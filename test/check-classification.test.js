import { describe, expect, it } from "vitest";

import {
  classifyCheck,
  parseCheckClassificationYaml,
} from "../scripts/read-check-classification.mjs";

describe("check classification source of truth", () => {
  it("parses required and informative checks from the canonical yaml", () => {
    const policy = parseCheckClassificationYaml([
      "required:",
      "  - Test",
      "informative:",
      "  - AI PR Review / discussion-review",
      "  - AI Wiki Update / update-wiki",
    ].join("\n"));

    expect(policy).toEqual({
      required: ["Test"],
      informative: [
        "AI PR Review / discussion-review",
        "AI Wiki Update / update-wiki",
      ],
    });
  });

  it("classifies blocking and advisory checks deterministically", () => {
    const policy = {
      required: ["Test"],
      informative: [
        "AI PR Review / discussion-review",
        "AI Wiki Update / update-wiki",
      ],
    };

    expect(classifyCheck(policy, "Test")).toEqual({
      context: "Test",
      classification: "required",
      blocking: true,
    });
    expect(classifyCheck(policy, "AI PR Review / discussion-review")).toEqual({
      context: "AI PR Review / discussion-review",
      classification: "informative",
      blocking: false,
    });
  });

  it("fails closed for an unclassified check", () => {
    expect(() => classifyCheck({
      required: ["Test"],
      informative: [],
    }, "unknown-check")).toThrow(/not classified/i);
  });
});
