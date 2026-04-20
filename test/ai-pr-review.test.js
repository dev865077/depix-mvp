/**
 * Focused tests for the PR review gate and recommendation parser.
 */
import { describe, expect, it } from "vitest";

import {
  assertValidReviewRecommendation,
  buildAutomationEvidenceContext,
  buildDiscussionCompletionComment,
  buildDiscussionDebateFailureSynthesis,
  buildDiscussionGateReview,
  buildDiscussionHistoryContext,
  buildMalformedBlockerContractMemo,
  assessDiscussionGate,
  buildDiscussionPublicationFallback,
  buildDiscussionReviewComments,
  buildModelFailureMemo,
  buildPullRequestCommentBody,
  buildPullRequestDiscussionBody,
  buildPullRequestUserPrompt,
  evaluateDiscussionRecommendation,
  extractDiscussionUrlFromComment,
  extractReviewRecommendation,
  getReviewGateFailure,
  parseBlockingRoleContract,
  sanitizePublishedMarkdown,
  selectDiscussionCategory,
  sortFilesForReview,
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

  it("keeps Blocked planning-only by rejecting it in PR review recommendations", () => {
    const review = [
      "Blocked",
      "",
      "## Findings",
      "- Waiting on another change.",
      "",
      "## Recommendation",
      "Blocked",
    ].join("\n");

    expect(() => assertValidReviewRecommendation(review)).toThrow(/missing the ## Recommendation section|Invalid AI review recommendation/i);
  });

  it("turns Request changes into a failing GitHub check verdict", () => {
    expect(getReviewGateFailure("Approve")).toBeNull();
    expect(getReviewGateFailure("Request changes")?.message).toContain("final recommendation is blocking");
  });

  it("requires unanimous approve in the discussion lane", () => {
    const unanimous = evaluateDiscussionRecommendation({
      product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
      technical: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
      synthesis: "Approve\n\n## Findings\n- No material findings.\n\n## Recommendation\nApprove",
    });
    const blocked = evaluateDiscussionRecommendation({
      product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
      technical: "## Perspective\nNeeds changes.\n\n## Findings\n- Blocker.\n\n## Questions\n- None.\n\n## Merge posture\nNot ready.\n\n## Recommendation\nRequest changes",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
      synthesis: "Approve\n\n## Findings\n- No material findings.\n\n## Recommendation\nApprove",
    });

    expect(unanimous.recommendation).toBe("Approve");
    expect(unanimous.blockingRoles).toEqual([]);
    expect(unanimous.canReuseSynthesisApproveBody).toBe(true);
    expect(blocked.recommendation).toBe("Request changes");
    expect(blocked.blockingRoles).toEqual(["technical"]);
  });

  it("treats synthesis as summary-only when specialists are unanimously approved", () => {
    const evaluation = evaluateDiscussionRecommendation({
      product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
      technical: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
      synthesis: "Request changes\n\n## Findings\n- Summary drift.\n\n## Recommendation\nRequest changes",
    });

    expect(evaluation.recommendation).toBe("Approve");
    expect(evaluation.blockingRoles).toEqual([]);
    expect(evaluation.synthesisRecommendation).toBe("Request changes");
    expect(evaluation.canReuseSynthesisApproveBody).toBe(false);
  });

  it("fails closed when a specialist omits the canonical recommendation", () => {
    expect(() =>
      evaluateDiscussionRecommendation({
        product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.",
        technical: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
        risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Merge posture\nReady.\n\n## Recommendation\nApprove",
        synthesis: "Approve\n\n## Findings\n- No material findings.\n\n## Recommendation\nApprove",
      }),
    ).toThrow(/missing the ## Recommendation section/i);
  });

  it("parses a valid Testable blocker contract from a blocking specialist memo", () => {
    const review = [
      "## Perspective",
      "Needs one deterministic blocker contract.",
      "",
      "## Findings",
      "- Current payload is under-specified.",
      "",
      "## Questions",
      "- None.",
      "",
      "## Merge posture",
      "Not ready yet.",
      "",
      "## Blocker contract",
      "Testability: Testable",
      "Behavior protected: Canonical blocker schema is emitted identically across roles.",
      "Suggested test file: test/ai-pr-review.test.js",
      "Minimum scenario: Generate one blocking memo from a specialist prompt.",
      "Essential assertions:",
      "- includes Testability",
      "- includes Behavior protected",
      "Resolution rule: The blocker clears when the canonical schema parses without ambiguity.",
      "Why this test resolves the blocker: It proves the emitted blocker is machine-readable.",
      "",
      "## Recommendation",
      "Request changes",
    ].join("\n");

    expect(parseBlockingRoleContract(review)).toEqual({
      status: "valid",
      testability: "Testable",
      fields: {
        Testability: "Testable",
        "Behavior protected": "Canonical blocker schema is emitted identically across roles.",
        "Suggested test file": "test/ai-pr-review.test.js",
        "Minimum scenario": "Generate one blocking memo from a specialist prompt.",
        "Essential assertions": "- includes Testability\n- includes Behavior protected",
        "Resolution rule": "The blocker clears when the canonical schema parses without ambiguity.",
        "Why this test resolves the blocker": "It proves the emitted blocker is machine-readable.",
      },
    });
  });

  it("parses a valid Not testable blocker contract from a blocking specialist memo", () => {
    const review = [
      "## Perspective",
      "Human judgment is still required.",
      "",
      "## Findings",
      "- This is a product-only tradeoff.",
      "",
      "## Questions",
      "- None.",
      "",
      "## Merge posture",
      "Not ready yet.",
      "",
      "## Blocker contract",
      "Testability: Not testable",
      "Reason: The blocker is a policy decision, not a runtime behavior.",
      "Required human resolution: Maintainer must choose the intended policy.",
      "",
      "## Recommendation",
      "Request changes",
    ].join("\n");

    expect(parseBlockingRoleContract(review)).toEqual({
      status: "valid",
      testability: "Not testable",
      fields: {
        Testability: "Not testable",
        Reason: "The blocker is a policy decision, not a runtime behavior.",
        "Required human resolution": "Maintainer must choose the intended policy.",
      },
    });
  });

  it("treats legacy blocking prose without Testability as malformed", () => {
    const review = [
      "## Perspective",
      "Old format.",
      "",
      "## Findings",
      "- Blocker without canonical contract.",
      "",
      "## Questions",
      "- None.",
      "",
      "## Merge posture",
      "Not ready.",
      "",
      "## Recommendation",
      "Request changes",
    ].join("\n");

    expect(parseBlockingRoleContract(review)).toEqual({
      status: "malformed",
      reason: "Missing required section: ## Blocker contract.",
    });
  });

  it("rejects free-floating blocker labels outside the blocker section", () => {
    const review = [
      "## Perspective",
      "Section missing even though the labels exist.",
      "",
      "## Findings",
      "- One blocker.",
      "",
      "## Questions",
      "- None.",
      "",
      "## Merge posture",
      "Not ready.",
      "",
      "Testability: Testable",
      "Behavior protected: Validation only accepts fields inside the blocker section.",
      "Suggested test file: test/ai-pr-review.test.js",
      "Minimum scenario: Parse one memo without the blocker heading.",
      "Essential assertions: parse returns malformed.",
      "Resolution rule: Require the section heading.",
      "Why this test resolves the blocker: It locks the contract boundary.",
      "",
      "## Recommendation",
      "Request changes",
    ].join("\n");

    expect(parseBlockingRoleContract(review)).toEqual({
      status: "malformed",
      reason: "Missing required section: ## Blocker contract.",
    });
  });

  it("treats contradictory duplicate blocker fields as malformed", () => {
    const review = [
      "## Perspective",
      "Duplicate conflict.",
      "",
      "## Findings",
      "- Conflicting file path.",
      "",
      "## Questions",
      "- None.",
      "",
      "## Merge posture",
      "Not ready.",
      "",
      "## Blocker contract",
      "Testability: Testable",
      "Behavior protected: Canonical blocker schema is emitted identically across roles.",
      "Suggested test file: test/ai-pr-review.test.js",
      "Suggested test file: test/other.test.js",
      "Minimum scenario: Generate one blocking memo.",
      "Essential assertions: includes Testability",
      "Resolution rule: The blocker clears when parsing is deterministic.",
      "Why this test resolves the blocker: It proves machine readability.",
      "",
      "## Recommendation",
      "Request changes",
    ].join("\n");

    expect(parseBlockingRoleContract(review)).toEqual({
      status: "malformed",
      reason: "Conflicting duplicate field: Suggested test file.",
    });
  });

  it("accepts non-conflicting extra prose around a valid blocker contract", () => {
    const review = [
      "## Perspective",
      "Extra context is okay.",
      "",
      "## Findings",
      "- One blocker.",
      "",
      "## Merge posture",
      "Not ready.",
      "",
      "## Blocker contract",
      "Testability: Testable",
      "Behavior protected: Canonical blocker schema is emitted identically across roles.",
      "Suggested test file: test/ai-pr-review.test.js",
      "Minimum scenario: Generate one blocking memo.",
      "Essential assertions: includes Testability",
      "Resolution rule: The blocker clears when parsing is deterministic.",
      "Why this test resolves the blocker: It proves machine readability.",
      "",
      "Extra note: this sentence is contextual and should be ignored by the parser.",
      "",
      "## Recommendation",
      "Request changes",
    ].join("\n");

    expect(parseBlockingRoleContract(review).status).toBe("valid");
  });

  it("builds a canonical malformed blocker memo", () => {
    const memo = buildMalformedBlockerContractMemo("Technical and architecture", "Missing required field: Testability.");

    expect(memo).toContain("Contract status: Malformed");
    expect(memo).toContain("Malformed reason: Missing required field: Testability.");
    expect(memo).toContain("Required human resolution: regenerate the review with the canonical blocker contract");
    expect(memo).toContain("## Recommendation\nRequest changes");
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
        filename: ".github/prompts/ai-pr-discussion-product.md",
        additions: 6,
        deletions: 0,
        patch: [
          "@@",
          "+- In `## Recommendation`, say exactly one of:",
          "+  - `Approve`",
          "+  - `Request changes`",
        ].join("\n"),
      },
      {
        filename: "scripts/ai-pr-review.mjs",
        additions: 240,
        deletions: 0,
        patch: [
          "@@",
          "+function isSmallReviewAutomationPolicyChange(files, summary) {",
          "+  return summary.totalChangedLines <= 320;",
          "+}",
        ].join("\n"),
      },
      {
        filename: "test/ai-pr-review.test.js",
        additions: 28,
        deletions: 0,
        patch: [
          "@@",
          "+it(\"keeps small automation policy changes direct\", () => {",
          "+  expect(true).toBe(true);",
          "+});",
        ].join("\n"),
      },
      {
        filename: ".github/prompts/ai-pr-discussion-technical.md",
        additions: 6,
        deletions: 0,
        patch: [
          "@@",
          "+- In `## Recommendation`, say exactly one of:",
          "+  - `Approve`",
          "+  - `Request changes`",
        ].join("\n"),
      },
      {
        filename: ".github/prompts/ai-pr-discussion-risk.md",
        additions: 6,
        deletions: 0,
        patch: [
          "@@",
          "+- In `## Recommendation`, say exactly one of:",
          "+  - `Approve`",
          "+  - `Request changes`",
        ].join("\n"),
      },
      {
        filename: ".github/prompts/ai-pr-discussion-synthesis.md",
        additions: 3,
        deletions: 0,
        patch: [
          "@@",
          "+- Always include the final `## Recommendation` section exactly once.",
        ].join("\n"),
      },
      {
        filename: "docs/wiki/Contribuicao-e-PRs.md",
        additions: 11,
        deletions: 1,
        patch: [
          "@@",
          "+- na lane de Discussion, a PR so fica pronta para merge quando `product`, `technical` e `risk` retornarem `Approve`",
          "+- `synthesis` continua obrigatoria para visibilidade, mas e resumo",
        ].join("\n"),
      },
    ]);

    expect(gate.requiresDiscussion).toBe(false);
    expect(gate.route).toBe("direct_review");
  });

  it("keeps small review automation prompt-only tuning in the direct lane", () => {
    const gate = assessDiscussionGate([
      {
        filename: ".github/prompts/ai-pr-discussion-product.md",
        additions: 4,
        deletions: 1,
        patch: "@@\n+- Keep output very short.",
      },
      {
        filename: ".github/prompts/ai-pr-discussion-synthesis.md",
        additions: 4,
        deletions: 1,
        patch: "@@\n+- Keep output very short.",
      },
      {
        filename: "scripts/ai-pr-review.mjs",
        additions: 14,
        deletions: 3,
        patch: "@@\n+const allowedPromptPath = true;",
      },
      {
        filename: "test/ai-pr-review.test.js",
        additions: 12,
        deletions: 0,
        patch: "@@\n+expect(gate.route).toBe(\"direct_review\");",
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
      { filename: ".github/prompts/ai-pr-discussion-product.md", additions: 3, deletions: 0 },
      { filename: ".github/workflows/ai-pr-review.yml", additions: 12, deletions: 2 },
      { filename: "test/app.test.js", additions: 5, deletions: 0 },
    ]);

    expect(summary.categories).toEqual(["prompt", "source", "tests", "workflow"]);
    expect(summary.areas).toEqual([".github", "src", "test"]);
    expect(summary.totalChangedLines).toBe(33);
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
    const blocked = buildDiscussionCompletionComment("Request changes", ["risk"]);
    const followUpApproved = buildDiscussionCompletionComment("Approve", [], { isFollowUpRound: true });

    expect(approved).toContain("<!-- ai-pr-discussion-final:openai -->");
    expect(approved).toContain("Discussion concluded");
    expect(approved).toContain("Final recommendation: `Approve`");
    expect(approved).toContain("visible closure marker");
    expect(approved).toContain("all specialist reviewer roles returned `Approve`");
    expect(approved).toContain("`synthesis` is summary-only");
    expect(approved).toContain("newest final-status comment supersedes earlier automated final-status comments");
    expect(approved).toContain("canonical_state: `pr_ready_to_merge`");
    expect(approved).toContain("ready_for_merge: `true`");
    expect(blocked).toContain("Final recommendation: `Request changes`");
    expect(blocked).toContain("unanimous approval was not reached across the specialist reviewer roles");
    expect(blocked).toContain("`risk`");
    expect(blocked).toContain("newest final-status comment supersedes earlier automated final-status comments");
    expect(blocked).toContain("canonical_state: `pr_review_request_changes`");
    expect(blocked).toContain("ready_for_merge: `false`");
    expect(followUpApproved).toContain("Why this passed now");
    expect(followUpApproved).toContain("resolved the prior blockers");
  });

  it("turns model timeouts into bounded request-changes output", () => {
    const memo = buildModelFailureMemo("Technical and architecture", new DOMException("Timed out", "TimeoutError"));
    const synthesis = buildDiscussionDebateFailureSynthesis([
      { role: "Technical and architecture", error: new DOMException("Timed out", "TimeoutError") },
    ]);

    expect(memo).toContain("could not complete");
    expect(assertValidReviewRecommendation(memo)).toBe("Request changes");
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
      "",
      [
        "## Automation contract evidence",
        "- Current PR review workflow state: discussion-comment reruns are enabled.",
      ].join("\n"),
    );

    expect(body).toContain("Repository: dev865077/depix-mvp");
    expect(body).toContain("PR: #60 - Automate review");
    expect(body).toContain("Base branch: main");
    expect(body).toContain("Head branch: codex/issue-57-multi-bot-debate");
    expect(body).toContain("## Automation contract evidence");
    expect(body).toContain("scripts/ai-pr-review.mjs");
  });

  it("includes prior append-only Discussion comments in the reviewer prompt", () => {
    const discussionContext = buildDiscussionHistoryContext([
      {
        author: { login: "dev865077" },
        publishedAt: "2026-04-18T22:14:58Z",
        body: "Atualizacao append-only: retry sequencial testado e `npm test` passou.",
      },
      {
        author: { login: "github-actions" },
        publishedAt: "2026-04-18T22:15:13Z",
        body: "Final recommendation: `Request changes`",
      },
    ]);
    const body = buildPullRequestUserPrompt(
      "dev865077/depix-mvp",
      {
        number: 72,
        title: "Deposit recheck",
        html_url: "https://github.com/dev865077/depix-mvp/pull/72",
        body: "Adds recheck.",
        base: { ref: "main" },
        head: { ref: "codex/issue-10-deposit-recheck" },
      },
      [
        {
          filename: "test/deposit-recheck.test.js",
          status: "modified",
          additions: 20,
          deletions: 0,
          patch: "@@\n+retry sequencial testado",
        },
      ],
      gate,
      discussionContext,
    );

    expect(body).toContain("## Existing Discussion context");
    expect(body).toContain("2026-04-18T22:14:58Z by dev865077");
    expect(body).toContain("retry sequencial testado");
    expect(body).toContain("Final recommendation: `Request changes`");
    expect(body.indexOf("## Existing Discussion context")).toBeLessThan(body.indexOf("## Changed files digest"));
  });

  it("builds rerun context from the conclusion thread while dropping stale specialist bot output", () => {
    const discussionContext = buildDiscussionHistoryContext([
      {
        author: { login: "github-actions[bot]" },
        publishedAt: "2026-04-18T22:14:58Z",
        body: [
          "<!-- ai-pr-discussion-review:openai -->",
          "<!-- ai-pr-discussion-role:technical -->",
          "## Technical and architecture review",
          "",
          "## Findings",
          "- Old blocker.",
          "",
          "## Recommendation",
          "Request changes",
        ].join("\n"),
        replies: { nodes: [] },
      },
      {
        id: "final-1",
        author: { login: "github-actions" },
        publishedAt: "2026-04-18T22:15:13Z",
        body: [
          "<!-- ai-pr-discussion-final:openai -->",
          "Final recommendation: `Request changes`",
        ].join("\n"),
        replies: {
          nodes: [
            {
              author: { login: "dev865077" },
              createdAt: "2026-04-18T22:16:00Z",
              body: "Resolvido: agora existe teste cobrindo a regressao e o contrato ficou explicito.",
            },
            {
              author: { login: "dev865077" },
              createdAt: "2026-04-18T22:17:00Z",
              body: "Estou citando <!-- ai-pr-discussion-final:openai --> para explicar o bug anterior.",
            },
          ],
        },
      },
      {
        author: { login: "dev865077" },
        publishedAt: "2026-04-18T22:18:00Z",
        body: "Comentario humano solto fora da thread final.",
        replies: { nodes: [] },
      },
    ]);

    expect(discussionContext).not.toContain("Old blocker");
    expect(discussionContext).toContain("## Latest conclusion thread");
    expect(discussionContext).toContain("Previous automated conclusion");
    expect(discussionContext).toContain("Final recommendation: `Request changes`");
    expect(discussionContext).toContain("Resolvido: agora existe teste cobrindo a regressao");
    expect(discussionContext).toContain("citando <!-- ai-pr-discussion-final:openai -->");
    expect(discussionContext).toContain("Comentario humano solto fora da thread final");
  });

  it("prioritizes current source and test evidence ahead of docs in broad review payloads", () => {
    const files = [
      { filename: "docs/wiki/A.md", status: "modified", additions: 1, deletions: 0, patch: "@@\n+docs" },
      { filename: "docs/wiki/B.md", status: "modified", additions: 1, deletions: 0, patch: "@@\n+docs" },
      { filename: "src/routes/health.js", status: "modified", additions: 1, deletions: 0, patch: "@@\n+tenantOverrides" },
      { filename: "test/health.test.js", status: "modified", additions: 1, deletions: 0, patch: "@@\n+tenantOverrides" },
    ];

    expect(sortFilesForReview(files).slice(0, 2).map((file) => file.filename)).toEqual([
      "src/routes/health.js",
      "test/health.test.js",
    ]);

    const body = buildPullRequestUserPrompt(
      "dev865077/depix-mvp",
      {
        number: 72,
        title: "Deposit recheck",
        html_url: "https://github.com/dev865077/depix-mvp/pull/72",
        body: "Adds recheck.",
        base: { ref: "main" },
        head: { ref: "codex/issue-10-deposit-recheck" },
      },
      files,
      gate,
    );

    expect(body.indexOf("### src/routes/health.js")).toBeLessThan(body.indexOf("### docs/wiki/A.md"));
    expect(body).toContain("+tenantOverrides");
  });

  it("keeps safety-critical auth and recheck files ahead of ordinary source files", () => {
    const files = [
      { filename: "src/app.js", status: "modified", additions: 1, deletions: 0, patch: "@@\n+app" },
      {
        filename: "src/services/eulen-deposit-recheck.js",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@\n+atomic recheck",
      },
      {
        filename: "src/services/ops-route-authorization.js",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@\n+fail closed",
      },
    ];

    expect(sortFilesForReview(files).map((file) => file.filename)).toEqual([
      "src/services/eulen-deposit-recheck.js",
      "src/services/ops-route-authorization.js",
      "src/app.js",
    ]);
  });

  it("caps the changed-files digest instead of letting it consume the review context", () => {
    const files = [
      {
        filename: "src/services/ops-route-authorization.js",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@\n+fail closed",
      },
      ...Array.from({ length: 25 }, (_, index) => ({
        filename: `docs/wiki/Noise-${index}.md`,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@\n+docs",
      })),
    ];

    const body = buildPullRequestUserPrompt(
      "dev865077/depix-mvp",
      {
        number: 72,
        title: "Deposit recheck",
        html_url: "https://github.com/dev865077/depix-mvp/pull/72",
        body: "Adds recheck.",
        base: { ref: "main" },
        head: { ref: "codex/issue-10-deposit-recheck" },
      },
      files,
      gate,
    );

    expect(body).toContain("- src/services/ops-route-authorization.js");
    expect(body).toContain("Additional files omitted from digest: 2 lower-priority file(s).");
    expect(body).toContain("Only the top 24 review-priority files were sent to the model.");
    expect(body).not.toContain("- docs/wiki/Noise-8.md");
    expect(body).not.toContain("### docs/wiki/Noise-8.md");
  });

  it("sends complete current evidence for critical discussion-review files", () => {
    const files = [
      ...Array.from({ length: 20 }, (_, index) => ({
        filename: `docs/wiki/Long-${index}.md`,
        status: "modified",
        additions: 200,
        deletions: 0,
        patch: ["@@", ...Array.from({ length: 200 }, () => "+documentation noise")].join("\n"),
      })),
      {
        filename: "src/services/ops-route-authorization.js",
        status: "modified",
        additions: 3,
        deletions: 0,
        patch: "@@\n+tenant override declared\n+missing binding fails closed\n+AUTH_SENTINEL",
      },
      {
        filename: "src/services/eulen-deposit-recheck.js",
        status: "modified",
        additions: 650,
        deletions: 0,
        patch: [
          "@@",
          "+D1 batch persists audit event",
          ...Array.from({ length: 640 }, () => "+critical recheck implementation evidence"),
          "+RECHECK_SENTINEL",
        ].join("\n"),
      },
      {
        filename: "src/routes/health.js",
        status: "modified",
        additions: 3,
        deletions: 0,
        patch: "@@\n+tenantOverrides redacted\n+tenantSummary preserves compatibility\n+HEALTH_SENTINEL",
      },
      {
        filename: "test/deposit-recheck.test.js",
        status: "modified",
        additions: 3,
        deletions: 0,
        patch: "@@\n+override missing returns 503\n+fetch is not called\n+DEPOSIT_TEST_SENTINEL",
      },
      {
        filename: "test/health.test.js",
        status: "modified",
        additions: 3,
        deletions: 0,
        patch: "@@\n+tenantOverrides only state and invalidCount\n+tenant inventory remains available\n+HEALTH_TEST_SENTINEL",
      },
    ];

    const body = buildPullRequestUserPrompt(
      "dev865077/depix-mvp",
      {
        number: 72,
        title: "Deposit recheck",
        html_url: "https://github.com/dev865077/depix-mvp/pull/72",
        body: "Adds recheck.",
        base: { ref: "main" },
        head: { ref: "codex/issue-10-deposit-recheck" },
      },
      files,
      gate,
    );

    for (const sentinel of [
      "AUTH_SENTINEL",
      "RECHECK_SENTINEL",
      "HEALTH_SENTINEL",
      "DEPOSIT_TEST_SENTINEL",
      "HEALTH_TEST_SENTINEL",
    ]) {
      expect(body).toContain(sentinel);
    }

    const recheckSection = body.slice(
      body.indexOf("### src/services/eulen-deposit-recheck.js"),
      body.indexOf("### src/services/ops-route-authorization.js"),
    );

    expect(recheckSection).not.toContain("[truncated]");
    expect(body.indexOf("### src/services/eulen-deposit-recheck.js")).toBeLessThan(
      body.indexOf("### docs/wiki/Long-0.md"),
    );
    expect(body.indexOf("### src/services/ops-route-authorization.js")).toBeLessThan(
      body.indexOf("### docs/wiki/Long-0.md"),
    );
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

  it("renders a request-changes gate summary when unanimity is broken", () => {
    const review = buildDiscussionGateReview(
      {
        product: "## Recommendation\nApprove",
        technical: "## Recommendation\nRequest changes",
        risk: "## Recommendation\nApprove",
        synthesis: "Approve\n\n## Findings\n- No material findings.\n\n## Recommendation\nApprove",
      },
      {
        recommendations: {
          product: "Approve",
          technical: "Request changes",
          risk: "Approve",
          synthesis: "Approve",
        },
        blockingRoles: ["technical"],
        recommendation: "Request changes",
      },
    );

    expect(assertValidReviewRecommendation(review)).toBe("Request changes");
    expect(review).toContain("requires unanimous `Approve` from Product, Technical, and Risk");
    expect(review).toContain("`technical`");
  });

  it("renders an approve gate summary when specialists approve and synthesis drifts", () => {
    const review = buildDiscussionGateReview(
      {
        product: "## Recommendation\nApprove",
        technical: "## Recommendation\nApprove",
        risk: "## Recommendation\nApprove",
        synthesis: "Request changes\n\n## Findings\n- Summary drift.\n\n## Recommendation\nRequest changes",
      },
      {
        recommendations: {
          product: "Approve",
          technical: "Approve",
          risk: "Approve",
          synthesis: "Request changes",
        },
        blockingRoles: [],
        synthesisRecommendation: "Request changes",
        canReuseSynthesisApproveBody: false,
        recommendation: "Approve",
      },
    );

    expect(assertValidReviewRecommendation(review)).toBe("Approve");
    expect(review).toContain("`synthesis` diverged");
    expect(review).toContain("summary-only");
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

  it("pins the discussion-comment entrypoint and discussion-review write permissions in the workflow", () => {
    const evidence = buildAutomationEvidenceContext({
      files: [
        { filename: ".github/workflows/ai-pr-review.yml" },
        { filename: ".github/workflows/ai-issue-planning-review.yml" },
        { filename: "scripts/ai-pr-review.mjs" },
        { filename: "scripts/ai-issue-planning-review.mjs" },
        { filename: "scripts/ai-issue-triage.mjs" },
        { filename: "test/ai-pr-review.test.js" },
        { filename: "test/ai-issue-planning-review.test.js" },
        { filename: "test/ai-issue-triage.test.js" },
      ],
      prReviewWorkflow: [
        "on:",
        "  discussion_comment:",
        "jobs:",
        "  discussion-review:",
        "    permissions:",
        "      discussions: write",
      ].join("\n"),
      planningWorkflow: [
        "outputs:",
        "  planning_status:",
        "  blocking_roles:",
        "  blocked_by_dependencies:",
        ">> \"$GITHUB_STEP_SUMMARY\"",
      ].join("\n"),
      prReviewScript: [
        "resolvePullRequestContext();",
        "buildDiscussionHistoryContext();",
        "replyToId: latestFinalComment?.id ?? null,",
      ].join("\n"),
      planningScript: [
        "\"Blocked\"",
        "writeGitHubOutput(\"planning_status\", value);",
        "writeGitHubOutput(\"blocked_by_dependencies\", value);",
      ].join("\n"),
      triageScript: [
        "executionReadiness",
        "needsDiscussion",
      ].join("\n"),
      prReviewTests: [
        "keeps Blocked planning-only by rejecting it in PR review recommendations",
        "pins the discussion-comment entrypoint and discussion-review write permissions in the workflow",
      ].join("\n"),
      planningTests: "pins planning workflow outputs in the operator summary",
      triageTests: [
        "still allows medium-impact issues to route directly when execution is already clear",
        "still sends low-impact but ambiguous issues into discussion before PR",
      ].join("\n"),
    });

    expect(evidence).toContain("## Automation contract evidence");
    expect(evidence).toContain("discussion-review");
    expect(evidence).toContain("$GITHUB_STEP_SUMMARY");
    expect(evidence).toContain("Blocked");
    expect(evidence).toContain("medio -> direct_pr");
  });
});
