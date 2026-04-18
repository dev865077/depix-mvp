/**
 * Testes do parser de recomendacao da AI review.
 */
import { describe, expect, it } from "vitest";

import { assertValidReviewRecommendation, extractReviewRecommendation } from "../scripts/ai-pr-review.mjs";

describe("ai pr review recommendation parser", () => {
  it("reads the canonical recommendation section", () => {
    const review = [
      "Request changes",
      "",
      "## Findings",
      "- Something important.",
      "",
      "## Recommendation",
      "Request changes",
    ].join("\n");

    expect(extractReviewRecommendation(review)).toBe("Request changes");
    expect(assertValidReviewRecommendation(review)).toBe("Request changes");
  });

  it("accepts inline recommendation headings", () => {
    const review = [
      "Approve",
      "",
      "## Findings",
      "- No material findings.",
      "",
      "## Recommendation: Approve",
    ].join("\n");

    expect(assertValidReviewRecommendation(review)).toBe("Approve");
  });

  it("accepts a plain recommendation label", () => {
    const review = [
      "Request changes",
      "",
      "## Findings",
      "- Regression risk.",
      "",
      "Recommendation: Request changes",
    ].join("\n");

    expect(assertValidReviewRecommendation(review)).toBe("Request changes");
  });

  it("falls back to the first non-empty verdict line when needed", () => {
    const review = [
      "Approve",
      "",
      "## Findings",
      "- No material findings.",
    ].join("\n");

    expect(assertValidReviewRecommendation(review)).toBe("Approve");
  });

  it("still rejects forbidden follow-up approval verdicts", () => {
    const review = [
      "Approve with later changes",
      "",
      "## Findings",
      "- Follow-up needed.",
      "",
      "## Recommendation",
      "Approve with later changes",
    ].join("\n");

    expect(() => assertValidReviewRecommendation(review)).toThrow(/Forbidden recommendation/);
  });

  it("still rejects malformed recommendations that cannot be normalized", () => {
    const review = [
      "Looks good",
      "",
      "## Findings",
      "- No material findings.",
      "",
      "## Recommendation",
      "Ship it",
    ].join("\n");

    expect(() => assertValidReviewRecommendation(review)).toThrow(/missing the ## Recommendation section|Invalid AI review recommendation/);
  });
});
