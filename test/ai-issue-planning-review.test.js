/**
 * Focused tests for the issue planning review workflow.
 */
import { describe, expect, it } from "vitest";

import {
  buildDiscussionHistoryContext,
  buildIssuePlanningCompletionComment,
  buildIssuePlanningReviewComments,
  buildIssuePlanningUserPrompt,
  buildModelFailureMemo,
  evaluateIssuePlanningRecommendation,
  extractIssueNumberFromDiscussion,
  extractIssueNumberFromText,
  extractPlanningRecommendation,
  parseReferencedIssueNumbers,
} from "../scripts/ai-issue-planning-review.mjs";

describe("ai issue planning review", () => {
  it("extracts issue numbers from discussion titles and bodies", () => {
    expect(extractIssueNumberFromText("[Issue #116] Debater backlog")).toBe(116);
    expect(extractIssueNumberFromText("Issue origem: #91 - epic")).toBe(91);
    expect(extractIssueNumberFromText("nothing here")).toBeNull();
    expect(extractIssueNumberFromDiscussion({ title: "[Issue #77] Planejar MVP", body: "" })).toBe(77);
  });

  it("parses referenced child issues from the root issue body", () => {
    const issueNumbers = parseReferencedIssueNumbers(
      [
        "- [ ] #83",
        "- [x] #84",
        "Depende de #90 e #91, mas nao deve repetir #91.",
      ].join("\n"),
      91,
    );

    expect(issueNumbers).toEqual([83, 84, 90]);
  });

  it("reads the canonical recommendation contract", () => {
    const memo = [
      "## Perspective",
      "Ok.",
      "",
      "## Findings",
      "- None.",
      "",
      "## Questions",
      "- None.",
      "",
      "## Backlog posture",
      "Ready.",
      "",
      "## Recommendation",
      "Approve",
    ].join("\n");

    expect(extractPlanningRecommendation(memo)).toBe("Approve");
    expect(buildModelFailureMemo("Risk", new Error("timeout"))).toContain("Request changes");
  });

  it("requires unanimous approval across the four specialist roles", () => {
    const unanimous = evaluateIssuePlanningRecommendation({
      product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      technical: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      scrum: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
    });
    const blocked = evaluateIssuePlanningRecommendation({
      product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      technical: "## Perspective\nNeeds split.\n\n## Findings\n- Too broad.\n\n## Questions\n- None.\n\n## Backlog posture\nNot ready.\n\n## Recommendation\nRequest changes",
      scrum: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
    });

    expect(unanimous.recommendation).toBe("Approve");
    expect(unanimous.blockingRoles).toEqual([]);
    expect(blocked.recommendation).toBe("Request changes");
    expect(blocked.blockingRoles).toEqual(["technical"]);
  });

  it("builds append-only discussion comments and final status", () => {
    const comments = buildIssuePlanningReviewComments({
      product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      technical: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      scrum: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
    });
    const completion = buildIssuePlanningCompletionComment("Request changes", ["scrum", "risk"]);

    expect(comments).toHaveLength(4);
    expect(comments[2].body).toContain("<!-- ai-issue-planning-role:scrum -->");
    expect(completion).toContain("Execution readiness requires unanimous `Approve`");
    expect(completion).toContain("`scrum`");
    expect(completion).toContain("`risk`");
  });

  it("builds prompt context with child issues and discussion history", () => {
    const prompt = buildIssuePlanningUserPrompt(
      "dev865077/depix-mvp",
      {
        number: 91,
        title: "epic",
        state: "open",
        html_url: "https://github.com/dev865077/depix-mvp/issues/91",
        body: "Raiz",
      },
      [
        {
          number: 90,
          title: "validar production",
          state: "closed",
          labels: [{ name: "sub-issue" }],
          body: "Evidencia controlada.",
        },
      ],
      [
        {
          user: { login: "dev865077" },
          created_at: "2026-04-19T00:00:00Z",
          body: "Comentario de issue.",
        },
      ],
      buildDiscussionHistoryContext({
        comments: {
          nodes: [
            {
              author: { login: "github-actions" },
              createdAt: "2026-04-19T00:00:01Z",
              body: "Comentario principal.",
              replies: {
                nodes: [
                  {
                    author: { login: "dev865077" },
                    createdAt: "2026-04-19T00:00:02Z",
                    body: "Resposta operacional.",
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(prompt).toContain("Root issue: #91 - epic");
    expect(prompt).toContain("#90 - validar production");
    expect(prompt).toContain("Comentario de issue.");
    expect(prompt).toContain("Resposta operacional.");
  });
});
