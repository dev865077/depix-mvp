/**
 * Focused tests for the issue planning review workflow.
 */
import { describe, expect, it } from "vitest";
import issuePlanningWorkflowText from "../.github/workflows/ai-issue-planning-review.yml?raw";

import {
  buildIssueRefinementDispatchInputs,
  buildIssueRefinementDispatchRequest,
  buildDiscussionHistoryContext,
  buildIssueCommentContext,
  buildIssuePlanningAutomationSection,
  buildIssuePlanningDiscussionBody,
  buildIssuePlanningCompletionComment,
  buildIssuePlanningStatusComment,
  buildIssuePlanningReviewComments,
  buildIssuePlanningUserPrompt,
  buildModelFailureMemo,
  evaluateIssuePlanningRecommendation,
  extractIssueTriageRouteFromComment,
  extractIssueTriageRouteFromComments,
  extractIssueNumberFromDiscussion,
  extractIssueNumberFromText,
  extractPlanningRecommendation,
  fetchReferencedChildIssues,
  findMatchingIssuePlanningDiscussionNumber,
  hasCanonicalIssuePlanningEntrypoints,
  isAutomatedIssueMetaComment,
  isAutomatedIssueMetaCommentBody,
  isAutomatedPlanningComment,
  isAutomatedPlanningCommentBody,
  isAutomationDiscussionCommentEvent,
  isIssuePlanningHandoffCommentEvent,
  parseManualPlanningTarget,
  parseReferencedIssueNumbers,
  resolveReferencedIssueFetchSkipReason,
  resolveIssueRefinementDispatchRef,
  resolvePlanningConcurrencyTarget,
  selectPlanningDiscussionCategory,
  isIgnorableReferencedIssueFetchError,
  stripIssueAutomationSection,
  upsertIssueAutomationSection,
  extractMarkdownSection,
} from "../scripts/ai-issue-planning-review.mjs";

describe("ai issue planning review", () => {
  it("keeps the real issue planning workflow on the canonical entrypoints", () => {
    expect(hasCanonicalIssuePlanningEntrypoints(issuePlanningWorkflowText)).toBe(true);
    expect(issuePlanningWorkflowText).toContain("workflow_dispatch:");
    expect(issuePlanningWorkflowText).toContain("discussion:");
    expect(issuePlanningWorkflowText).toContain("discussion_comment:");
    expect(issuePlanningWorkflowText).not.toMatch(/^\s+issues\s*:\s*$/m);
    expect(issuePlanningWorkflowText).not.toMatch(/^\s+issue_comment\s*:\s*$/m);
  });

  it("keeps issue planning entrypoints canonical to avoid duplicate Discussions", () => {
    expect(hasCanonicalIssuePlanningEntrypoints([
      "on:",
      "  workflow_dispatch:",
      "  discussion:",
      "  discussion_comment:",
    ].join("\n"))).toBe(true);

    expect(hasCanonicalIssuePlanningEntrypoints([
      "on:",
      "  workflow_dispatch:",
      "  issues:",
      "  discussion:",
      "  discussion_comment:",
      "  issue_comment:",
      "jobs:",
      "  review:",
      "    if: contains(github.event.comment.body, '<!-- ai-issue-triage:openai -->')",
    ].join("\n"))).toBe(false);
  });

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

  it("only treats automated triage issue comments as planning handoffs", () => {
    expect(isIssuePlanningHandoffCommentEvent({
      action: "created",
      issue: { number: 213 },
      comment: {
        user: { login: "github-actions[bot]" },
        body: [
          "<!-- ai-issue-triage:openai -->",
          "Rota canonica: `discussion_before_pr`",
        ].join("\n"),
      },
    })).toBe(true);
    expect(isIssuePlanningHandoffCommentEvent({
      action: "created",
      issue: { number: 213 },
      comment: { user: { login: "github-actions[bot]" }, body: "comentario humano comum" },
    })).toBe(false);
    expect(isIssuePlanningHandoffCommentEvent({
      action: "created",
      issue: { number: 215, pull_request: {} },
      comment: { user: { login: "github-actions[bot]" }, body: "<!-- ai-issue-triage:openai -->" },
    })).toBe(false);
    expect(isIssuePlanningHandoffCommentEvent({
      action: "edited",
      issue: { number: 213 },
      comment: { user: { login: "github-actions[bot]" }, body: "<!-- ai-issue-triage:openai -->" },
    })).toBe(false);
    expect(isIssuePlanningHandoffCommentEvent({
      action: "created",
      issue: { number: 213 },
      comment: { user: { login: "dev865077" }, body: "<!-- ai-issue-triage:openai -->" },
    })).toBe(false);
  });

  it("keeps the latest specialist reviewer memos while dropping stale automated status noise", () => {
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
            author: { login: "github-actions" },
            createdAt: "2026-04-19T00:00:01Z",
            body: [
              "<!-- ai-issue-planning-review:openai -->",
              "<!-- ai-issue-planning-role:product -->",
              "## Product and scope review",
              "## Findings",
              "- Stop conditions agora existem.",
              "",
              "## Recommendation",
              "Request changes",
            ].join("\n"),
            replies: { nodes: [] },
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
    expect(history).toContain("Latest specialist reviewer memos");
    expect(history).toContain("## Product and scope review");
    expect(history).toContain("Latest planning conclusion thread");
    expect(history).toContain("Final recommendation: `Request changes`");
    expect(history).toContain("Stop conditions");
    expect(history).toContain("citando o marcador");
    expect(history).toContain("PR docs-only");
  });

  it("keeps only the newest memo for each specialist role in follow-up context", () => {
    const history = buildDiscussionHistoryContext({
      comments: {
        nodes: [
          {
            author: { login: "github-actions" },
            createdAt: "2026-04-19T00:00:01Z",
            body: [
              "<!-- ai-issue-planning-review:openai -->",
              "<!-- ai-issue-planning-role:technical -->",
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
            author: { login: "github-actions" },
            createdAt: "2026-04-19T00:00:02Z",
            body: [
              "<!-- ai-issue-planning-review:openai -->",
              "<!-- ai-issue-planning-role:technical -->",
              "## Technical and architecture review",
              "",
              "## Findings",
              "- New blocker.",
              "",
              "## Recommendation",
              "Request changes",
            ].join("\n"),
            replies: { nodes: [] },
          },
          {
            author: { login: "github-actions" },
            createdAt: "2026-04-19T00:00:03Z",
            body: [
              "<!-- ai-issue-planning-final:openai -->",
              "Final recommendation: `Request changes`",
            ].join("\n"),
            replies: {
              nodes: [
                {
                  author: { login: "dev865077" },
                  createdAt: "2026-04-19T00:00:04Z",
                  body: "Resposta operacional mais nova.",
                },
              ],
            },
          },
        ],
      },
    });

    expect(history).toContain("New blocker.");
    expect(history).not.toContain("Old blocker.");
    expect(history).toContain("Resposta operacional mais nova.");
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

  it("reads triage handoff routes and selects a planning category", () => {
    const triageBody = [
      "<!-- ai-issue-triage:openai -->",
      "## AI Issue Triage",
      "Rota canonica: `discussion_before_pr`",
    ].join("\n");
    const legacyDirectBody = "Fluxo recomendado: `PR direta`";
    const legacyDiscussionBody = "Fluxo recomendado: `Discussion antes da PR`";
    const categories = [
      { id: "1", name: "General", isAnswerable: false },
      { id: "2", name: "Ideas", isAnswerable: false },
      { id: "3", name: "Q&A", isAnswerable: true },
    ];

    expect(extractIssueTriageRouteFromComment(triageBody)).toBe("discussion_before_pr");
    expect(extractIssueTriageRouteFromComment(legacyDirectBody)).toBe("direct_pr");
    expect(extractIssueTriageRouteFromComment(legacyDiscussionBody)).toBe("discussion_before_pr");
    expect(extractIssueTriageRouteFromComments([
      { user: { login: "github-actions[bot]" }, body: triageBody },
    ])).toBe("discussion_before_pr");
    expect(selectPlanningDiscussionCategory(categories, "Ideas").id).toBe("2");
    expect(selectPlanningDiscussionCategory(categories, "Missing").id).toBe("2");
  });

  it("builds the API-owned planning discussion body", () => {
    const body = buildIssuePlanningDiscussionBody({
      number: 213,
      title: "Automatizar fluxo",
      html_url: "https://github.com/dev865077/depix-mvp/issues/213",
      body: [
        "Issue detalhada.",
        "",
        "<!-- ai-issue-automation:start -->",
        "## Canonical automation handoff",
        "route: `discussion_before_pr`",
        "<!-- ai-issue-automation:end -->",
      ].join("\n"),
    }, "Rota canonica: `discussion_before_pr`");

    expect(body).toContain("Issue origem: #213");
    expect(body).toContain("Discussion canonica de planning");
    expect(body).toContain("canonical_state: `issue_planning_in_progress`");
    expect(body).toContain("ready_for_codex: `false`");
    expect(body).toContain("Rota canonica: `discussion_before_pr`");
    expect(body).toContain("Issue detalhada.");
    expect(body).not.toContain("<!-- ai-issue-automation:start -->");
  });

  it("finds an existing canonical planning discussion before creating a new one", () => {
    expect(findMatchingIssuePlanningDiscussionNumber(213, [
      { number: 210, title: "[PR #209] Improve Telegram QR payment guidance" },
      { number: 216, title: "[Issue #213] Automatizar fluxo canonico" },
    ])).toBe(216);
    expect(findMatchingIssuePlanningDiscussionNumber(214, [
      { number: 216, title: "[Issue #213] Automatizar fluxo canonico" },
    ])).toBeNull();
  });

  it("parses referenced child issues from the root issue body", () => {
    const issueNumbers = parseReferencedIssueNumbers(
      [
        "- [ ] #83",
        "- [x] #84",
        "Depende de #90 e #91, mas nao deve repetir #91.",
        "Exemplo recente: o blocker no PR #209 nao deve virar dependencia.",
        "Outro exemplo de pull request #210 tambem nao deve entrar.",
        "Variacao comum: PR#211 tambem e texto, nao dependencia.",
        "Outra variacao: PR: #212 segue sendo prose.",
        "Outra ainda: pull request: #213 tambem nao entra.",
      ].join("\n"),
      91,
    );

    expect(issueNumbers).toEqual([83, 84, 90]);
  });

  it("only ignores referenced issue fetch failures when the child context is inaccessible", () => {
    expect(isIgnorableReferencedIssueFetchError(new Error("GitHub API request failed (403): nope"))).toBe(true);
    expect(isIgnorableReferencedIssueFetchError(new Error("GitHub API request failed (404): nope"))).toBe(true);
    expect(isIgnorableReferencedIssueFetchError({ status: 403, message: "forbidden" })).toBe(true);
    expect(isIgnorableReferencedIssueFetchError({ response: { status: 404 }, message: "not found" })).toBe(true);
    expect(isIgnorableReferencedIssueFetchError(new Error("GitHub API request failed (500): nope"))).toBe(false);
    expect(isIgnorableReferencedIssueFetchError(new Error("network timeout"))).toBe(false);
  });

  it("classifies inaccessible child issue skips with stable reasons", () => {
    expect(resolveReferencedIssueFetchSkipReason({ status: 403 })).toBe("reference_forbidden");
    expect(resolveReferencedIssueFetchSkipReason({ response: { status: 404 } })).toBe("reference_not_found");
    expect(resolveReferencedIssueFetchSkipReason(new Error("opaque access problem"))).toBe("reference_not_accessible");
  });

  it("skips inaccessible referenced child issues while keeping accessible planning context", async () => {
    const loggedEvents = [];
    const warnings = [];
    const childIssues = await fetchReferencedChildIssues(
      "dev865077/depix-mvp",
      [83, 209, 210],
      {
        fetchIssueFn: async (_repoFullName, issueNumber) => {
          if (issueNumber === 83) {
            return { number: 83, title: "Accessible child issue" };
          }

          if (issueNumber === 209) {
            const error = new Error("GitHub API request failed (403): forbidden");
            error.status = 403;
            throw error;
          }

          const error = new Error("missing");
          error.response = { status: 404 };
          throw error;
        },
        logEventFn: (event, fields = {}) => {
          loggedEvents.push({ event, fields });
        },
        emitWarningFn: (message) => {
          warnings.push(message);
        },
      },
    );

    expect(childIssues).toEqual([{ number: 83, title: "Accessible child issue" }]);
    expect(loggedEvents).toEqual([
      {
        event: "ai_issue_planning_review.child_issue.skipped",
        fields: {
          issueNumber: 209,
          reason: "reference_forbidden",
          status: 403,
          message: "GitHub API request failed (403): forbidden",
        },
      },
      {
        event: "ai_issue_planning_review.child_issue.skipped",
        fields: {
          issueNumber: 210,
          reason: "reference_not_found",
          status: 404,
          message: "missing",
        },
      },
    ]);
    expect(warnings).toEqual([
      "Planning skipped optional referenced issue #209 (reference_forbidden) and will continue without that child context.",
      "Planning skipped optional referenced issue #210 (reference_not_found) and will continue without that child context.",
    ]);
  });

  it("still throws when referenced child issue fetching fails for a real runtime problem", async () => {
    await expect(fetchReferencedChildIssues(
      "dev865077/depix-mvp",
      [83],
      {
        fetchIssueFn: async () => {
          const error = new Error("GitHub API request failed (500): boom");
          error.status = 500;
          throw error;
        },
      },
    )).rejects.toThrow("GitHub API request failed (500): boom");
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
    const issueReadyStatus = buildIssuePlanningStatusComment(
      "Approve",
      "https://github.com/dev865077/depix-mvp/discussions/212",
      [],
    );
    const issueBlockedStatus = buildIssuePlanningStatusComment(
      "Blocked",
      "https://github.com/dev865077/depix-mvp/discussions/212",
      ["technical"],
    );
    const issueChangesStatus = buildIssuePlanningStatusComment(
      "Request changes",
      "https://github.com/dev865077/depix-mvp/discussions/212",
      ["technical"],
    );

    expect(comments).toHaveLength(4);
    expect(comments[2].body).toContain("<!-- ai-issue-planning-role:scrum -->");
    expect(blockedCompletion).toContain("well specified, but execution is still blocked");
    expect(blockedCompletion).toContain("`Blocked`");
    expect(blockedCompletion).toContain("canonical_state: `issue_planning_blocked`");
    expect(blockedCompletion).toContain("ready_for_codex: `false`");
    expect(completion).toContain("Execution readiness requires unanimous `Approve`");
    expect(completion).toContain("`scrum`");
    expect(completion).toContain("`risk`");
    expect(followUpApproved).toContain("Why this passed now");
    expect(followUpApproved).toContain("resolved the previous planning blockers");
    expect(followUpApproved).toContain("canonical_state: `issue_ready_for_codex`");
    expect(followUpApproved).toContain("next_actor: `codex`");
    expect(issueReadyStatus).toContain("<!-- ai-issue-planning-status:openai -->");
    expect(issueReadyStatus).toContain("ready_for_codex: `true`");
    expect(issueReadyStatus).toContain("next_action: `open_branch_and_pr`");
    expect(issueBlockedStatus).toContain("next_actor: `dependency_owner`");
    expect(issueBlockedStatus).toContain("next_action: `wait_for_dependencies`");
    expect(issueBlockedStatus).toContain("blocked_by_dependencies: `true`");
    expect(issueBlockedStatus).toContain("blocking_roles: `technical`");
    expect(issueChangesStatus).toContain("next_actor: `issue_refinement_agent`");
    expect(issueChangesStatus).toContain("next_action: `refine_issue_and_reply_to_planning_conclusion`");
  });

  it("builds the exact workflow dispatch request used by issue refinement handoff", () => {
    const request = buildIssueRefinementDispatchRequest(
      "dev865077/depix-mvp",
      {
        issueNumber: 291,
        discussionNumber: 292,
        planningStatus: "request_changes",
        blockingRoles: ["product", "technical"],
        blockedByDependencies: false,
      },
      " trunk ",
    );

    expect(buildIssueRefinementDispatchInputs({
      issueNumber: 291,
      discussionNumber: 292,
      planningStatus: "blocked",
      blockingRoles: ["risk"],
      blockedByDependencies: true,
    })).toEqual({
      issue_number: "291",
      discussion_number: "292",
      planning_status: "blocked",
      blocking_roles: "risk",
      blocked_by_dependencies: "true",
    });
    expect(resolveIssueRefinementDispatchRef({ repository: { default_branch: "trunk" } }, {})).toBe("trunk");
    expect(resolveIssueRefinementDispatchRef({}, { GITHUB_REF: "refs/heads/main" })).toBe("main");
    expect(request.url).toBe(
      "https://api.github.com/repos/dev865077/depix-mvp/actions/workflows/ai-issue-refinement.yml/dispatches",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(request.init.body)).toEqual({
      ref: "trunk",
      inputs: {
        issue_number: "291",
        discussion_number: "292",
        planning_status: "request_changes",
        blocking_roles: "product,technical",
        blocked_by_dependencies: "false",
      },
    });
    expect(() => buildIssueRefinementDispatchRequest("invalid", {
      issueNumber: 291,
      discussionNumber: 292,
      planningStatus: "request_changes",
    }, "main")).toThrow("Invalid repository");
  });

  it("builds a managed planning section directly on the issue body", () => {
    const section = buildIssuePlanningAutomationSection({
      recommendation: "Request changes",
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/212",
      blockingRoles: ["technical", "risk"],
      model: "gpt-test",
      debate: {
        product: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nReady once blockers clear.\n\n## Recommendation\nApprove",
        technical: "## Perspective\nNeeds split.\n\n## Findings\n- Split the issue into executable slices.\n\n## Questions\n- None.\n\n## Backlog posture\nNot implementation-ready yet.\n\n## Recommendation\nRequest changes",
        scrum: "## Perspective\nOk.\n\n## Findings\n- None.\n\n## Questions\n- None.\n\n## Backlog posture\nSequence is explicit.\n\n## Recommendation\nApprove",
        risk: "## Perspective\nNeed evidence.\n\n## Findings\n- Add explicit validation evidence.\n\n## Questions\n- None.\n\n## Backlog posture\nOperational proof is still missing.\n\n## Recommendation\nRequest changes",
      },
    });
    const mergedBody = upsertIssueAutomationSection("## Problema\nTexto humano.", section);

    expect(section).toContain("planning_discussion: https://github.com/dev865077/depix-mvp/discussions/212");
    expect(section).toContain("final_recommendation: `Request changes`");
    expect(section).toContain("### Technical");
    expect(section).toContain("Split the issue into executable slices.");
    expect(section).toContain("## Codex handoff");
    expect(mergedBody).toContain("## Problema");
    expect(stripIssueAutomationSection(mergedBody)).toBe("## Problema\nTexto humano.");
  });

  it("extracts stable markdown sections from specialist memos", () => {
    const memo = [
      "## Perspective",
      "Ok.",
      "",
      "## Findings",
      "- First blocker.",
      "- Second blocker.",
      "",
      "## Questions",
      "- None.",
      "",
      "## Backlog posture",
      "Ready after the split.",
      "",
      "## Recommendation",
      "Request changes",
    ].join("\n");

    expect(extractMarkdownSection(memo, "Findings")).toContain("First blocker.");
    expect(extractMarkdownSection(memo, "Backlog posture")).toBe("Ready after the split.");
  });

  it("builds prompt context with child issues and discussion history", () => {
    const prompt = buildIssuePlanningUserPrompt(
      "dev865077/depix-mvp",
      {
        number: 91,
        title: "epic",
        state: "open",
        html_url: "https://github.com/dev865077/depix-mvp/issues/91",
        body: [
          "Raiz",
          "",
          "<!-- ai-issue-automation:start -->",
          "## Canonical automation handoff",
          "route: `discussion_before_pr`",
          "<!-- ai-issue-automation:end -->",
        ].join("\n"),
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
              createdAt: "2026-04-19T00:00:00Z",
              body: [
                "<!-- ai-issue-planning-review:openai -->",
                "<!-- ai-issue-planning-role:technical -->",
                "## Technical and architecture review",
                "",
                "## Findings",
                "- Nomear o boundary canonico.",
                "",
                "## Recommendation",
                "Request changes",
              ].join("\n"),
              replies: { nodes: [] },
            },
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
    expect(prompt).toContain("Artifact kind hint: issue");
    expect(prompt).toContain("Referenced child issue count: 1");
    expect(prompt).toContain("Epic title valid: true");
    expect(prompt).toContain("#90 - validar production");
    expect(prompt).toContain("Comentario de issue.");
    expect(prompt).toContain("Resposta operacional.");
    expect(prompt).toContain("Latest specialist reviewer memos");
    expect(prompt).toContain("Latest planning conclusion thread");
    expect(prompt).toContain("Final recommendation: `Request changes`");
    expect(prompt).toContain("Raiz");
    expect(prompt).not.toContain("<!-- ai-issue-automation:start -->");
  });

  it("marks epic titles without child issues as invalid planning artifacts in the prompt", () => {
    const prompt = buildIssuePlanningUserPrompt(
      "dev865077/depix-mvp",
      {
        number: 291,
        title: "epic: release 0.1 readiness",
        state: "open",
        html_url: "https://github.com/dev865077/depix-mvp/issues/291",
        body: "Checklist de prontidao.",
      },
      [],
      [],
      "",
    );

    expect(prompt).toContain("Artifact kind hint: epic");
    expect(prompt).toContain("Referenced child issue count: 0");
    expect(prompt).toContain("Epic title valid: false");
  });

});
