/**
 * Focused tests for the PR review gate and recommendation parser.
 */
import { describe, expect, it } from "vitest";

import {
  assertValidReviewRecommendation,
  buildDiscussionCompletionComment,
  buildDiscussionDebateFailureSynthesis,
  assessDiscussionGate,
  buildDiscussionPublicationFallback,
  buildDiscussionReviewComments,
  buildModelFailureMemo,
  buildPullRequestCommentBody,
  buildPullRequestDiscussionBody,
  buildPullRequestUserPrompt,
  extractDiscussionUrlFromComment,
  extractReviewRecommendation,
  getReviewGateFailure,
  sanitizePublishedMarkdown,
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

  it("turns Request changes into a failing GitHub check verdict", () => {
    expect(getReviewGateFailure("Approve")).toBeNull();
    expect(getReviewGateFailure("Request changes")?.message).toContain("final recommendation is blocking");
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

  it("keeps the direct lane inclusive at the documented boundary", () => {
    const gate = assessDiscussionGate([
      { filename: "README.md", additions: 40, deletions: 0 },
      { filename: "docs/wiki/Runbook.md", additions: 40, deletions: 0 },
      { filename: "docs/wiki/Architecture.md", additions: 40, deletions: 0 },
    ]);

    expect(gate.requiresDiscussion).toBe(false);
  });

  it("routes docs-only pull requests to discussion when they exceed the size boundary", () => {
    const gate = assessDiscussionGate([
      { filename: "README.md", additions: 121, deletions: 0 },
    ]);

    expect(gate.requiresDiscussion).toBe(true);
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

  it("keeps tiny non-sensitive workflow tuning in the direct lane", () => {
    const gate = assessDiscussionGate([
      {
        filename: ".github/workflows/ai-pr-review.yml",
        additions: 1,
        deletions: 0,
        patch: [
          "@@",
          "         env:",
          "           AI_PR_REVIEW_MODE: classify",
          "+          OPENAI_PR_REVIEW_MODEL: ${{ vars.OPENAI_PR_CLASSIFY_MODEL || 'gpt-5.4-nano' }}",
        ].join("\n"),
      },
    ]);

    expect(gate.requiresDiscussion).toBe(false);
    expect(gate.route).toBe("direct_review");
  });

  it("routes sensitive workflow permission changes into discussion even when tiny", () => {
    const gate = assessDiscussionGate([
      {
        filename: ".github/workflows/ai-pr-review.yml",
        additions: 1,
        deletions: 0,
        patch: [
          "@@",
          "     permissions:",
          "-      contents: read",
          "+      contents: write",
        ].join("\n"),
      },
    ]);

    expect(gate.requiresDiscussion).toBe(true);
  });

  it("keeps small review automation policy changes in the direct lane", () => {
    const gate = assessDiscussionGate([
      {
        filename: ".github/workflows/ai-pr-review.yml",
        additions: 1,
        deletions: 0,
        patch: [
          "@@",
          "+          OPENAI_PR_REVIEW_MODEL: ${{ vars.OPENAI_PR_CLASSIFY_MODEL || 'gpt-5.4-nano' }}",
        ].join("\n"),
      },
      {
        filename: "scripts/ai-pr-review.mjs",
        additions: 80,
        deletions: 0,
        patch: [
          "@@",
          "+function isSmallReviewAutomationPolicyChange(files, summary) {",
          "+  return summary.totalChangedLines <= 160;",
          "+}",
        ].join("\n"),
      },
      {
        filename: "test/ai-pr-review.test.js",
        additions: 24,
        deletions: 0,
        patch: [
          "@@",
          "+it(\"keeps small automation policy changes direct\", () => {",
          "+  expect(true).toBe(true);",
          "+});",
        ].join("\n"),
      },
      {
        filename: "docs/wiki/Contribuicao-e-PRs.md",
        additions: 4,
        deletions: 2,
        patch: [
          "@@",
          "+- PR pequena de automacao de review pode ficar direta quando nao toca escopo sensivel.",
        ].join("\n"),
      },
    ]);

    expect(gate.requiresDiscussion).toBe(false);
    expect(gate.route).toBe("direct_review");
  });

  it("routes review automation policy changes to discussion when they touch token or permission scope", () => {
    const gate = assessDiscussionGate([
      {
        filename: "scripts/ai-pr-review.mjs",
        additions: 2,
        deletions: 0,
        patch: [
          "@@",
          "+const token = process.env.GITHUB_TOKEN;",
          "+await grantPermission(\"issues: write\");",
        ].join("\n"),
      },
      {
        filename: "test/ai-pr-review.test.js",
        additions: 2,
        deletions: 0,
        patch: "@@\n+expect(token).toBeDefined();",
      },
    ]);

    expect(gate.requiresDiscussion).toBe(true);
  });

  it("routes mixed docs and source changes into discussion", () => {
    const gate = assessDiscussionGate([
      { filename: "docs/wiki/Runbook.md", additions: 4, deletions: 0 },
      { filename: "src/index.js", additions: 1, deletions: 0 },
    ]);

    expect(gate.requiresDiscussion).toBe(true);
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

  it("builds the discussion body as an index for reviewer comments", () => {
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

    expect(body).toContain("## Review comments");
    expect(body).toContain("- Product and scope");
    expect(body).toContain("- Technical and architecture");
    expect(body).toContain("- Risk, security, and operations");
    expect(body).not.toContain("Scoped correctly.");
  });

  it("builds one discussion comment per reviewer role", () => {
    const roleComments = buildDiscussionReviewComments({
      product: "Product memo",
      technical: "Technical memo",
      risk: "Risk memo",
      synthesis: "Approve\n\n## Findings\n- No material findings.\n\n## Recommendation\nApprove",
    });

    expect(roleComments).toHaveLength(4);
    expect(roleComments.map((comment) => comment.marker)).toEqual([
      "<!-- ai-pr-discussion-role:product -->",
      "<!-- ai-pr-discussion-role:technical -->",
      "<!-- ai-pr-discussion-role:risk -->",
      "<!-- ai-pr-discussion-role:synthesis -->",
    ]);
    expect(roleComments.map((comment) => comment.role)).toEqual([
      "Product and scope",
      "Technical and architecture",
      "Risk, security, and operations",
      "Synthesis",
    ]);
    expect(roleComments.every((comment) => comment.body.includes("<!-- ai-pr-discussion-review:openai -->"))).toBe(true);
  });

  it("builds a visible final discussion status comment", () => {
    const approved = buildDiscussionCompletionComment("Approve");
    const blocked = buildDiscussionCompletionComment("Request changes");

    expect(approved).toContain("<!-- ai-pr-discussion-final:openai -->");
    expect(approved).toContain("Discussion concluded");
    expect(approved).toContain("Final recommendation: `Approve`");
    expect(approved).toContain("visible closure marker");
    expect(approved).toContain("newest final-status comment supersedes earlier automated final-status comments");
    expect(blocked).toContain("Final recommendation: `Request changes`");
    expect(blocked).toContain("remains open");
    expect(blocked).toContain("newest final-status comment supersedes earlier automated final-status comments");
  });

  it("turns model timeouts into bounded request-changes output", () => {
    const memo = buildModelFailureMemo("Technical and architecture", new DOMException("Timed out", "TimeoutError"));
    const synthesis = buildDiscussionDebateFailureSynthesis([
      { role: "Technical and architecture", error: new DOMException("Timed out", "TimeoutError") },
    ]);

    expect(memo).toContain("could not complete");
    expect(memo.length).toBeLessThan(900);
    expect(assertValidReviewRecommendation(synthesis)).toBe("Request changes");
    expect(synthesis).toContain("Rerun the discussion review");
    expect(buildDiscussionCompletionComment(assertValidReviewRecommendation(synthesis))).toContain(
      "Final recommendation: `Request changes`",
    );
  });

  it("builds the model payload from the GitHub pull_request shape", () => {
    const body = buildPullRequestUserPrompt(
      "dev865077/depix-mvp",
      {
        number: 60,
        title: "Automate review",
        html_url: "https://github.com/dev865077/depix-mvp/pull/60",
        body: "Adds review automation.",
        base: { ref: "main" },
        head: { ref: "codex/issue-57-multi-bot-debate" },
      },
      [
        {
          filename: "scripts/ai-pr-review.mjs",
          status: "modified",
          additions: 20,
          deletions: 5,
          patch: "@@ -1 +1 @@",
        },
      ],
      gate,
    );

    expect(body).toContain("Repository: dev865077/depix-mvp");
    expect(body).toContain("PR: #60 - Automate review");
    expect(body).toContain("Base branch: main");
    expect(body).toContain("Head branch: codex/issue-57-multi-bot-debate");
    expect(body).toContain("scripts/ai-pr-review.mjs");
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

  it("sanitizes model-authored mentions, images, and markdown links", () => {
    const sanitized = sanitizePublishedMarkdown(
      "Ping @dev865077 and @org/team. See [link](https://example.com) ![x](https://example.com/x.png)",
    );

    expect(sanitized).toContain("@<!-- -->dev865077");
    expect(sanitized).toContain("@<!-- -->org/team");
    expect(sanitized).toContain("link (https://example.com)");
    expect(sanitized).toContain("Image omitted");
  });

  it("sanitizes untrusted PR text inside discussion bodies", () => {
    const body = buildPullRequestDiscussionBody(
      {
        number: 57,
        title: "Ping @team",
        html_url: "https://github.com/dev865077/depix-mvp/pull/57",
        body: "Notify @dev865077 with [noise](https://example.com).",
      },
      gate,
      {
        product: "## Perspective\nScoped correctly.",
        technical: "## Perspective\nArchitecture is coherent.",
        risk: "## Perspective\nOperationally acceptable.",
        synthesis: "Approve\n\n## Findings\n- No material findings.\n\n## Recommendation\nApprove",
      },
      "gpt-5.4-mini",
    );

    expect(body).toContain("@<!-- -->dev865077");
    expect(body).not.toContain("[noise](https://example.com)");
  });

  it("renders a visible fallback when discussion publication fails", () => {
    const body = buildDiscussionPublicationFallback(new Error("GraphQL timeout"));

    expect(body).toContain("Discussion publication fallback");
    expect(body).toContain("check should fail");
    expect(body).toContain("GraphQL timeout");
  });

  it("keeps publication fallback messages bounded and markdown-safe", () => {
    const body = buildDiscussionPublicationFallback(new Error("GitHub said `nope` ".repeat(60)));

    expect(body).toContain("Discussion publication fallback");
    expect(body.length).toBeLessThan(900);
    expect(body).not.toContain("`nope`");
  });

  it("selects a safe discussion category", () => {
    const category = selectDiscussionCategory([
      { id: "1", name: "Announcements", isAnswerable: true },
      { id: "2", name: "Ideas", isAnswerable: false },
    ], "Missing");

    expect(category.id).toBe("2");
  });

  it("fails clearly when the repository has no discussion categories", () => {
    expect(() => selectDiscussionCategory([], "Architecture")).toThrow(/create at least one category/);
  });

  it("prefers the configured discussion category when available", () => {
    const category = selectDiscussionCategory([
      { id: "1", name: "General", isAnswerable: false },
      { id: "2", name: "Architecture", isAnswerable: false },
    ], "Architecture");

    expect(category.id).toBe("2");
  });

  it("returns a complete publication set for the discussion lane", () => {
    const discussionBody = buildPullRequestDiscussionBody(
      {
        number: 60,
        title: "Automate review",
        html_url: "https://github.com/dev865077/depix-mvp/pull/60",
        body: "Adds review automation.",
      },
      gate,
      {
        product: "Product memo",
        technical: "Technical memo",
        risk: "Risk memo",
        synthesis: "Request changes\n\n## Findings\n- One blocker.\n\n## Recommendation\nRequest changes",
      },
      "gpt-5.4-mini",
    );
    const roleComments = buildDiscussionReviewComments({
      product: "Product memo",
      technical: "Technical memo",
      risk: "Risk memo",
      synthesis: "Request changes\n\n## Findings\n- One blocker.\n\n## Recommendation\nRequest changes",
    });

    expect(discussionBody).toContain("## Review comments");
    expect(roleComments.map((comment) => comment.role)).toEqual([
      "Product and scope",
      "Technical and architecture",
      "Risk, security, and operations",
      "Synthesis",
    ]);
  });
});
