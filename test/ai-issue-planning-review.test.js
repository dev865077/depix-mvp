/**
 * Focused tests for the issue planning review workflow.
 */
import { describe, expect, it } from "vitest";

import {
  buildDiscussionHistoryContext,
  buildIssueCommentContext,
  buildIssuePlanningCompletionComment,
  buildIssuePlanningReviewComments,
  buildIssuePlanningUserPrompt,
  buildModelFailureMemo,
  evaluateIssuePlanningRecommendation,
  extractIssueNumberFromDiscussion,
  extractIssueNumberFromText,
  extractPlanningRecommendation,
  isAutomatedIssueMetaComment,
  isAutomatedIssueMetaCommentBody,
  isAutomatedPlanningComment,
  isAutomatedPlanningCommentBody,
  isAutomationDiscussionCommentEvent,
  parseManualPlanningTarget,
  parseReferencedIssueNumbers,
  resolvePlanningConcurrencyTarget,
} from "../scripts/ai-issue-planning-review.mjs";

describe("ai issue planning review", () => {
  it("extracts issue numbers from discussion titles and bodies", () => {
    expect(extractIssueNumberFromText("[Issue #116] Debater backlog")).toBe(116);
    expect(extractIssueNumberFromText("Issue origem: #91 - epic")).toBe(91);
    expect(extractIssueNumberFromText("nothing here")).toBeNull();
    expect(extractIssueNumberFromDiscussion({ title: "[Issue #77] Planejar MVP", body: "" })).toBe(77);
  });

  it("detects bot-authored discussion comment events to prevent loops", () => {
    expect(
      isAutomationDiscussionCommentEvent({
        discussion: { number: 12 },
        comment: { user: { login: "github-actions[bot]" } },
      }),
    ).toBe(true);
    expect(
      isAutomationDiscussionCommentEvent({
        discussion: { number: 12 },
        comment: { author: { login: "dev865077" } },
      }),
    ).toBe(false);
  });

  it("drops stale automated planning comments while keeping human replies", () => {
    const history = buildDiscussionHistoryContext({
      comments: {
        nodes: [
          {
            author: { login: "github-actions" },
            createdAt: "2026-04-19T00:00:01Z",
            body: [
              "<!-- ai-issue-planning-review:openai -->",
              "## Product and scope review",
              "## Recommendation",
              "Request changes",
            ].join("\n"),
            replies: {
              nodes: [
                {
                  author: { login: "dev865077" },
                  createdAt: "2026-04-19T00:01:00Z",
                  body: "Resolvido: a issue agora tem stop conditions e links canonicos.",
                },
              ],
            },
          },
          {
            author: { login: "dev865077" },
            createdAt: "2026-04-19T00:01:30Z",
            body: [
              "<!-- ai-issue-planning-review:openai -->",
              "Estou citando o marcador para explicar o bug.",
            ].join("\n"),
            replies: { nodes: [] },
          },
          {
            author: { login: "github-actions" },
            createdAt: "2026-04-19T00:00:02Z",
            body: [
              "<!-- ai-issue-planning-final:openai -->",
              "Final recommendation: `Request changes`",
            ].join("\n"),
            replies: { nodes: [] },
          },
          {
            author: { login: "dev865077" },
            createdAt: "2026-04-19T00:02:00Z",
            body: "Decisao operacional: seguir com PR docs-only.",
            replies: { nodes: [] },
          },
        ],
      },
    });

    expect(isAutomatedPlanningCommentBody("<!-- ai-issue-planning-final:openai -->")).toBe(true);
    expect(isAutomatedPlanningComment({
      author: { login: "dev865077" },
      body: "<!-- ai-issue-planning-final:openai --> citado por humano",
    })).toBe(false);
    expect(history).not.toContain("## Product and scope review");
    expect(history).toContain("Latest planning conclusion thread");
    expect(history).toContain("Final recommendation: `Request changes`");
    expect(history).not.toContain("stop conditions");
    expect(history).toContain("citando o marcador");
    expect(history).toContain("PR docs-only");
  });

  it("drops automated issue triage metadata while keeping human issue context", () => {
    const history = buildIssueCommentContext([
      {
        user: { login: "github-actions" },
        created_at: "2026-04-19T00:00:00Z",
        body: [
          "<!-- ai-issue-triage:openai -->",
          "## AI Issue Triage",
          "A issue so deve ser tratada como pronta depois da rodada unanime.",
        ].join("\n"),
      },
      {
        user: { login: "dev865077" },
        created_at: "2026-04-19T00:01:00Z",
        body: [
          "<!-- ai-issue-triage:openai -->",
          "Citando o marcador em um diagnostico humano.",
        ].join("\n"),
      },
      {
        user: { login: "dev865077" },
        created_at: "2026-04-19T00:02:00Z",
        body: "Decisao operacional: #132 e #135 sao blockers da epic, nao desta PR docs-only.",
      },
    ]);

    expect(isAutomatedIssueMetaCommentBody("<!-- ai-issue-triage:openai -->")).toBe(true);
    expect(isAutomatedIssueMetaComment({
      user: { login: "dev865077" },
      body: "<!-- ai-issue-triage:openai --> citado por humano",
    })).toBe(false);
    expect(history).not.toContain("AI Issue Triage");
    expect(history).not.toContain("rodada unanime");
    expect(history).toContain("diagnostico humano");
    expect(history).toContain("PR docs-only");
  });

  it("parses manual workflow rerun targets", () => {
    expect(parseManualPlanningTarget({ inputs: { issue_number: "91", discussion_number: "97" } })).toEqual({
      issueNumber: 91,
      discussionNumber: 97,
    });
    expect(parseManualPlanningTarget({ inputs: { issue_number: "abc", discussion_number: "" } })).toEqual({
      issueNumber: null,
      discussionNumber: null,
    });
  });

  it("builds stable planning concurrency targets across event kinds", () => {
    expect(resolvePlanningConcurrencyTarget({ inputs: { discussion_number: "97" } })).toBe("manual-discussion-97");
    expect(resolvePlanningConcurrencyTarget({ inputs: { issue_number: "91" } })).toBe("manual-issue-91");
    expect(resolvePlanningConcurrencyTarget({ issue: { number: 44 } })).toBe("issue-44");
    expect(resolvePlanningConcurrencyTarget({ discussion: { number: 12 } })).toBe("discussion-12");
    expect(resolvePlanningConcurrencyTarget({})).toBeNull();
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
      technical: "## Perspective\nDependency exists.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady once parent lands.\n\n## Recommendation\nBlocked",
      scrum: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
    });
    const requestChanges = evaluateIssuePlanningRecommendation({
      product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      technical: "## Perspective\nNeeds split.\n\n## Findings\n- Too broad.\n\n## Questions\n- None.\n\n## Backlog posture\nNot ready.\n\n## Recommendation\nRequest changes",
      scrum: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
    });

    expect(unanimous.recommendation).toBe("Approve");
    expect(unanimous.blockingRoles).toEqual([]);
    expect(blocked.recommendation).toBe("Blocked");
    expect(blocked.blockingRoles).toEqual(["technical"]);
    expect(blocked.blockedRoles).toEqual(["technical"]);
    expect(requestChanges.recommendation).toBe("Request changes");
    expect(requestChanges.changeRequestRoles).toEqual(["technical"]);
  });

  it("builds append-only discussion comments and final status", () => {
    const comments = buildIssuePlanningReviewComments({
      product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      technical: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      scrum: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
      risk: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady.\n\n## Recommendation\nApprove",
    });
    const blockedCompletion = buildIssuePlanningCompletionComment("Blocked", ["scrum"]);
    const completion = buildIssuePlanningCompletionComment("Request changes", ["scrum", "risk"]);
    const followUpApproved = buildIssuePlanningCompletionComment("Approve", [], { isFollowUpRound: true });

    expect(comments).toHaveLength(4);
    expect(comments[2].body).toContain("<!-- ai-issue-planning-role:scrum -->");
    expect(blockedCompletion).toContain("well specified, but execution is still blocked");
    expect(blockedCompletion).toContain("`Blocked`");
    expect(completion).toContain("Execution readiness requires unanimous `Approve`");
    expect(completion).toContain("`scrum`");
    expect(completion).toContain("`risk`");
    expect(followUpApproved).toContain("Why this passed now");
    expect(followUpApproved).toContain("resolved the previous planning blockers");
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
              id: "planning-final-1",
              author: { login: "github-actions" },
              createdAt: "2026-04-19T00:00:01Z",
              body: [
                "<!-- ai-issue-planning-final:openai -->",
                "Final recommendation: `Request changes`",
              ].join("\n"),
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
    expect(prompt).toContain("Latest planning conclusion thread");
    expect(prompt).toContain("Final recommendation: `Request changes`");
  });
});
