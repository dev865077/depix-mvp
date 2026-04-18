/**
 * Focused tests for the PR review gate and recommendation parser.
 */
import { describe, expect, it } from "vitest";

import {
  assertValidReviewRecommendation,
  assessDiscussionGate,
  buildPullRequestCommentBody,
  buildPullRequestDiscussionBody,
  extractDiscussionUrlFromComment,
  extractReviewRecommendation,
  selectDiscussionCategory,
  summarizePullRequestScope,
} from "../scripts/ai-pr-review.mjs";

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
});

describe("ai pr review discussion gate", () => {
  it("keeps tiny docs-only pull requests in the direct lane", () => {
    const gate = assessDiscussionGate([
      { filename: "README.md", additions: 10, deletions: 2 },
      { filename: "docs/wiki/Runbook.md", additions: 14, deletions: 3 },
    ]);

    expect(gate.requiresDiscussion).toBe(false);
    expect(gate.route).toBe("direct_review");
  });

  it("routes implementation changes into discussion before merge", () => {
    const gate = assessDiscussionGate([
      { filename: "src/routes/telegram.js", additions: 40, deletions: 8 },
      { filename: "test/telegram-webhook-reply.test.js", additions: 22, deletions: 0 },
    ]);

    expect(gate.requiresDiscussion).toBe(true);
    expect(gate.route).toBe("discussion_before_merge");
    expect(gate.reason).toContain("Meaningful PR scope");
  });

  it("summarizes categories and top-level areas deterministically", () => {
    const summary = summarizePullRequestScope([
      { filename: "src/app.js", additions: 10, deletions: 1 },
      { filename: ".github/workflows/ai-pr-review.yml", additions: 12, deletions: 2 },
      { filename: "test/app.test.js", additions: 5, deletions: 0 },
    ]);

    expect(summary.categories).toEqual(["source", "tests", "workflow"]);
    expect(summary.areas).toEqual([".github", "src", "test"]);
    expect(summary.totalChangedLines).toBe(30);
  });
});

describe("ai pr review discussion rendering", () => {
  const gate = {
    route: "discussion_before_merge",
    requiresDiscussion: true,
    reason: "Meaningful PR scope detected.",
    summary: {
      fileCount: 3,
      totalChangedLines: 150,
      topLevelAreaCount: 2,
      areas: ["src", "test"],
      categories: ["source", "tests"],
    },
  };

  it("builds the discussion body with all reviewer sections", () => {
    const body = buildPullRequestDiscussionBody(
      {
        number: 57,
        title: "Harden PR review workflow",
        html_url: "https://github.com/dev865077/depix-mvp/pull/57",
        body: "Implements the new workflow.",
      },
      gate,
      {
        product: "## Perspective\nScoped correctly.",
        technical: "## Perspective\nArchitecture is coherent.",
        risk: "## Perspective\nOperationally acceptable.",
        synthesis: "Request changes\n\n## Findings\n- Tighten one thing.\n\n## Recommendation\nRequest changes",
      },
      "gpt-5.4-mini",
    );

    expect(body).toContain("## Product and scope review");
    expect(body).toContain("## Technical and architecture review");
    expect(body).toContain("## Risk, security, and operations review");
    expect(body).toContain("## Synthesis");
  });

  it("builds the sticky comment with a discussion link when present", () => {
    const body = buildPullRequestCommentBody({
      model: "gpt-5.4-mini",
      gate,
      review: "Approve\n\n## Findings\n- No material findings.\n\n## Recommendation\nApprove",
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/12",
    });

    expect(body).toContain("## Discussion");
    expect(extractDiscussionUrlFromComment(body)).toBe("https://github.com/dev865077/depix-mvp/discussions/12");
  });

  it("selects a safe discussion category", () => {
    const category = selectDiscussionCategory([
      { id: "1", name: "Announcements", isAnswerable: true },
      { id: "2", name: "Ideas", isAnswerable: false },
    ], "Missing");

    expect(category.id).toBe("2");
  });
});
