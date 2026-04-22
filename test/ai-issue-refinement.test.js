/**
 * Focused tests for the issue refinement workflow.
 */
import { describe, expect, it } from "vitest";
import issueRefinementWorkflowText from "../.github/workflows/ai-issue-refinement.yml?raw";

import {
  assertValidIssuePlanningModeratorDecision,
  assertValidIssueRefinementPlan,
  buildGitHubSubIssueLinkRequest,
  buildIssuePlanningModeratorAutomationSection,
  buildIssuePlanningRerunDispatchRequest,
  buildIssuePlanningModeratorReplyBody,
  buildIssuePlanningModeratorStatusComment,
  buildIssuePlanningModeratorUserPrompt,
  buildIssueTriageDispatchRequest,
  buildIssueRefinementAutomationSection,
  buildIssueRefinementReplyBody,
  buildIssueRefinementStatusComment,
  buildIssueRefinementUserPrompt,
  countIssueRefinementRounds,
  countRefinementChildrenForParent,
  createOrReuseChildIssuesWithRequest,
  extractAutomationField,
  extractIssueAutomationSection,
  extractRefinementChildParentNumber,
  findLatestPlanningFinalComment,
  isRefinementChildIssue,
  normalizeChildIssueDrafts,
  normalizeModeratorChildIssueDrafts,
  normalizeIssueArtifactTitle,
  parseIssueRefinementDispatchInput,
  parseIssueRefinementResponse,
  runIssueRefinementWorkflow,
  selectChildIssueDraftsForCreation,
} from "../scripts/ai-issue-refinement.mjs";

describe("ai issue refinement", () => {
  it("keeps the refinement workflow as a workflow_dispatch API lane", () => {
    expect(issueRefinementWorkflowText).toContain("workflow_dispatch:");
    expect(issueRefinementWorkflowText).toContain("actions: write");
    expect(issueRefinementWorkflowText).toContain("discussions: write");
    expect(issueRefinementWorkflowText).toContain("issues: write");
    expect(issueRefinementWorkflowText).toContain("AI_ISSUE_REFINEMENT_PROVIDER");
    expect(issueRefinementWorkflowText).toContain("AI_ISSUE_PLANNING_MODERATOR_PROMPT_PATH");
    expect(issueRefinementWorkflowText).toContain("AI_ISSUE_REFINEMENT_MAX_ROUNDS: ${{ vars.AI_ISSUE_REFINEMENT_MAX_ROUNDS || '4' }}");
  });

  it("parses the workflow_dispatch payload for issue refinement", () => {
    expect(parseIssueRefinementDispatchInput({
      inputs: {
        issue_number: "291",
        discussion_number: "292",
        planning_status: "request_changes",
        blocking_roles: "product, technical, risk",
        blocked_by_dependencies: "false",
      },
    })).toEqual({
      issueNumber: 291,
      discussionNumber: 292,
      planningStatus: "request_changes",
      blockingRoles: ["product", "technical", "risk"],
      blockedByDependencies: false,
    });
  });

  it("extracts the managed issue section and automation fields", () => {
    const body = [
      "## Problema",
      "Texto humano.",
      "",
      "<!-- ai-issue-automation:start -->",
      "## Canonical automation handoff",
      "canonical_state: `issue_planning_request_changes`",
      "blocking_dependencies: `#144 | Banco aguardando callback`",
      "<!-- ai-issue-automation:end -->",
    ].join("\n");

    const section = extractIssueAutomationSection(body);

    expect(section).toContain("issue_planning_request_changes");
    expect(extractAutomationField(section, "canonical_state")).toBe("issue_planning_request_changes");
    expect(extractAutomationField(section, "blocking_dependencies")).toBe("#144 | Banco aguardando callback");
  });

  it("counts previous refinement rounds and finds the latest planning conclusion", () => {
    const discussion = {
      comments: {
        nodes: [
          {
            id: "planning-final-1",
            author: { login: "github-actions" },
            body: "<!-- ai-issue-planning-final:openai -->\nFinal recommendation: `Request changes`",
            replies: {
              nodes: [
                {
                  author: { login: "github-actions[bot]" },
                  body: "<!-- ai-issue-refinement:openai -->\n## Issue refinement update",
                },
                {
                  author: { login: "github-actions[bot]" },
                  body: "<!-- ai-issue-planning-final:openai -->\nFinal recommendation: `Request changes`",
                },
                {
                  author: { login: "github-actions[bot]" },
                  body: "<!-- ai-issue-refinement:openai -->\n## Issue refinement update",
                },
              ],
            },
          },
          {
            id: "plain-human-comment",
            author: { login: "dev865077" },
            body: "Contexto humano.",
            replies: { nodes: [] },
          },
        ],
      },
    };

    expect(countIssueRefinementRounds(discussion)).toBe(1);
    expect(findLatestPlanningFinalComment(discussion).id).toBe("planning-final-1");
  });

  it("parses, validates, and normalizes refinement output", () => {
    const plan = assertValidIssueRefinementPlan(`
      {
        "summary": "Split the umbrella artifact.",
        "updatedTitle": "epic: readiness 0.1",
        "updatedBodyHumanSection": "## Outcome\\nTightened scope.",
        "resolutionSummary": "Converted vague text into executable backlog.",
        "replyBody": "The issue now has executable slices and explicit acceptance.",
        "recommendedNextState": "issue_refinement_in_progress",
        "shouldRerunPlanning": true,
        "isNoOp": false,
        "failureReason": null,
        "blockingDependencies": [],
        "newChildIssues": [
          {
            "title": "sub-issue: validate banking callback evidence",
            "body": "Track proof ownership."
          }
        ]
      }
    `);

    expect(parseIssueRefinementResponse("{\"summary\":\"ok\",\"updatedTitle\":\"track: x\",\"updatedBodyHumanSection\":\"body\",\"resolutionSummary\":\"r\",\"replyBody\":\"reply\",\"recommendedNextState\":\"issue_planning_blocked\",\"shouldRerunPlanning\":false,\"isNoOp\":true,\"failureReason\":\"blocked\",\"blockingDependencies\":[],\"newChildIssues\":[]}").recommendedNextState).toBe("issue_planning_blocked");
    expect(plan.shouldRerunPlanning).toBe(true);
    expect(plan.newChildIssues).toHaveLength(1);
    expect(normalizeIssueArtifactTitle(plan.updatedTitle, 1)).toBe("track: readiness 0.1");
    expect(normalizeIssueArtifactTitle(plan.updatedTitle, 2)).toBe("epic: readiness 0.1");
  });

  it("bounds child issue drafts to four per refinement round", () => {
    const drafts = Array.from({ length: 8 }, (_, index) => ({
      title: `sub-issue: ${index}`,
      body: `Body ${index}`,
    }));

    expect(normalizeChildIssueDrafts(drafts)).toHaveLength(4);
  });

  it("bounds moderator split drafts to three child issues", () => {
    const drafts = Array.from({ length: 6 }, (_, index) => ({
      title: `sub-issue: ${index}`,
      body: `Body ${index}`,
    }));

    expect(normalizeModeratorChildIssueDrafts(drafts)).toHaveLength(3);
  });

  it("detects refinement child issues and blocks recursive child creation", () => {
    const childIssue = {
      number: 371,
      body: [
        "<!-- ai-issue-refinement-child:328:shared-reconciliation -->",
        "Parent issue: #328 - track: tornar confirmação resiliente",
        "",
        "Body.",
      ].join("\n"),
    };

    expect(extractRefinementChildParentNumber(childIssue)).toBe(328);
    expect(isRefinementChildIssue(childIssue)).toBe(true);
    expect(selectChildIssueDraftsForCreation(childIssue, [], [
      { title: "sub-issue: should not exist", body: "Body." },
    ])).toEqual([]);
  });

  it("enforces a root-level cap of twelve refinement child issues", () => {
    const parentIssue = { number: 328, body: "Root body." };
    const openIssues = Array.from({ length: 10 }, (_, index) => ({
      number: 330 + index,
      state: "open",
      body: `<!-- ai-issue-refinement-child:328:child-${index} -->\nParent issue: #328`,
    }));
    const drafts = Array.from({ length: 6 }, (_, index) => ({
      title: `sub-issue: new ${index}`,
      body: `Body ${index}`,
    }));

    expect(countRefinementChildrenForParent(openIssues, 328)).toBe(10);
    expect(selectChildIssueDraftsForCreation(parentIssue, openIssues, drafts)).toHaveLength(2);
    expect(selectChildIssueDraftsForCreation(parentIssue, [
      ...openIssues,
      { number: 340, state: "closed", body: "<!-- ai-issue-refinement-child:328:child-10 -->\nParent issue: #328" },
      { number: 341, state: "closed", body: "<!-- ai-issue-refinement-child:328:child-11 -->\nParent issue: #328" },
    ], drafts)).toEqual([]);
  });

  it("counts closed refinement child issues toward the root-level cap", () => {
    const parentIssue = { number: 328, body: "Root body." };
    const historicalIssues = Array.from({ length: 12 }, (_, index) => ({
      number: 330 + index,
      state: index % 2 === 0 ? "closed" : "open",
      body: `<!-- ai-issue-refinement-child:328:child-${index} -->\nParent issue: #328`,
    }));

    expect(countRefinementChildrenForParent(historicalIssues, 328)).toBe(12);
    expect(selectChildIssueDraftsForCreation(parentIssue, historicalIssues, [
      { title: "sub-issue: should not be created", body: "Body." },
    ])).toEqual([]);
  });

  it("builds the GitHub native sub-issue link request", () => {
    const request = buildGitHubSubIssueLinkRequest("dev865077/depix-mvp", 328, 123456);

    expect(request.url).toBe("https://api.github.com/repos/dev865077/depix-mvp/issues/328/sub_issues");
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(request.init.body)).toEqual({ sub_issue_id: 123456 });
  });

  it("fetches all issues before enforcing the root-level cap", async () => {
    const urls = [];
    const requestGitHub = async (url) => {
      urls.push(url);

      if (url.includes("/issues?state=all&per_page=100&page=1")) {
        return Array.from({ length: 12 }, (_, index) => ({
          id: 1000 + index,
          number: 330 + index,
          state: index % 2 === 0 ? "closed" : "open",
          title: `sub-issue: historical ${index}`,
          body: `<!-- ai-issue-refinement-child:328:historical-${index} -->\nParent issue: #328`,
        }));
      }

      throw new Error(`Unexpected GitHub request: ${url}`);
    };

    const created = await createOrReuseChildIssuesWithRequest(requestGitHub, "dev865077/depix-mvp", {
      number: 328,
      title: "track: root",
      body: "Root.",
    }, [
      { title: "sub-issue: should not be created", body: "Body." },
    ]);

    expect(created).toEqual([]);
    expect(urls).toEqual([
      "https://api.github.com/repos/dev865077/depix-mvp/issues?state=all&per_page=100&page=1",
    ]);
  });

  it("falls back visibly when native sub-issue linking fails after child creation", async () => {
    const requestGitHub = async (url, init = {}) => {
      if (url.includes("/issues?state=all&per_page=100&page=1")) {
        return [];
      }

      if (url.endsWith("/issues") && init.method === "POST") {
        return {
          id: 123456,
          number: 301,
          title: "sub-issue: validate callback proof",
          body: "Body.",
        };
      }

      if (url.endsWith("/issues/291/sub_issues") && init.method === "POST") {
        throw new Error("GitHub API request failed (403)");
      }

      throw new Error(`Unexpected GitHub request: ${url}`);
    };

    const createdIssues = await createOrReuseChildIssuesWithRequest(
      requestGitHub,
      "dev865077/depix-mvp",
      { number: 291, title: "track: root", body: "Root." },
      [{ title: "sub-issue: validate callback proof", body: "Body." }],
    );

    expect(createdIssues).toEqual([
      expect.objectContaining({
        number: 301,
        subIssueLink: {
          linked: false,
          reason: "GitHub API request failed (403)",
        },
      }),
    ]);
    expect(buildIssueRefinementReplyBody({
      phase: "rerun_planning",
      replyBody: "Child issue created; native link fallback surfaced.",
      createdChildIssues: createdIssues,
      blockingDependencies: [],
    })).toContain("native_sub_issue_link_fallback: #301 - GitHub API request failed (403)");
    expect(buildIssueRefinementStatusComment({
      phase: "rerun_planning",
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/292",
      planningStatus: "request_changes",
      blockingRoles: ["risk"],
      blockingDependencies: [],
      roundCount: 2,
      createdChildIssues: createdIssues,
    })).toContain("native_sub_issue_link_fallback_count: `1`");
    expect(buildIssueRefinementAutomationSection({
      phase: "rerun_planning",
      model: "gpt-test",
      provider: "openai_responses",
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/292",
      planningStatus: "request_changes",
      blockingRoles: ["risk"],
      blockingDependencies: [],
      roundCount: 2,
      summary: "Refined the issue.",
      resolutionSummary: "Created a child issue and surfaced link fallback.",
      createdChildIssues: createdIssues,
    })).toContain("## Native sub-issue link fallbacks");
  });

  it("builds prompt and canonical issue outputs for refinement", () => {
    const prompt = buildIssueRefinementUserPrompt({
      repository: "dev865077/depix-mvp",
      issue: {
        number: 291,
        title: "track: release 0.1 readiness",
        html_url: "https://github.com/dev865077/depix-mvp/issues/291",
      },
      discussion: { url: "https://github.com/dev865077/depix-mvp/discussions/292" },
      planningStatus: "request_changes",
      blockingRoles: ["product", "technical"],
      blockedByDependencies: false,
      roundCount: 2,
      maxRounds: 4,
      humanIssueBody: "## Outcome\nTight body.",
      currentManagedSection: "canonical_state: `issue_planning_request_changes`",
      childIssues: [
        {
          number: 144,
          title: "validate callback proof",
          state: "open",
          labels: [{ name: "sub-issue" }],
          body: "Evidencia.",
        },
      ],
      reviewerMemos: [
        {
          role: "technical",
          createdAt: "2026-04-21T12:00:00Z",
          body: "## Findings\n- Split the callback proof from release readiness.",
        },
      ],
      latestConclusionBody: "Final recommendation: `Request changes`",
      humanReplies: [
        {
          author: { login: "dev865077" },
          createdAt: "2026-04-21T12:10:00Z",
          body: "Vou quebrar isso em child issues.",
        },
      ],
      automatedReplies: [],
      discussionContext: "Latest planning conclusion thread",
      blockingDependencies: ["#144"],
    });
    const status = buildIssueRefinementStatusComment({
      phase: "rerun_planning",
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/292",
      planningStatus: "request_changes",
      blockingRoles: ["technical"],
      blockingDependencies: [],
      roundCount: 2,
    });
    const section = buildIssueRefinementAutomationSection({
      phase: "blocked",
      model: "gpt-test",
      provider: "openai_responses",
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/292",
      planningStatus: "blocked",
      blockingRoles: ["risk"],
      blockingDependencies: ["#144"],
      roundCount: 2,
      summary: "Refined the issue but dependency remains.",
      resolutionSummary: "All internal planning debt was removed.",
      createdChildIssues: [],
    });
    const reply = buildIssueRefinementReplyBody({
      phase: "rerun_planning",
      replyBody: "The issue now has executable child issues and explicit acceptance.",
      createdChildIssues: [{ number: 301, title: "sub-issue: validate callback proof" }],
      blockingDependencies: [],
    });

    expect(prompt).toContain("Root issue: #291 - track: release 0.1 readiness");
    expect(prompt).toContain("## Planning round context");
    expect(prompt).toContain("current_round: 2");
    expect(prompt).toContain("max_rounds: 4");
    expect(prompt).toContain("rounds_remaining: 2");
    expect(prompt).toContain("is_last_common_round_before_moderator: false");
    expect(prompt).toContain("Latest specialist reviewer memos");
    expect(prompt).toContain("Vou quebrar isso em child issues.");
    expect(status).toContain("next_actor: `ai_issue_planning_review`");
    expect(status).toContain("next_action: `run_four_specialist_review`");
    expect(section).toContain("canonical_state: `issue_planning_blocked`");
    expect(section).toContain("next_actor: `dependency_owner`");
    expect(reply).toContain("created_child_issue: #301 - sub-issue: validate callback proof");
  });

  it("builds prompt and canonical outputs for the final planning moderator", () => {
    const prompt = buildIssuePlanningModeratorUserPrompt({
      repository: "dev865077/depix-mvp",
      issue: {
        number: 610,
        title: "track: moderador final",
        html_url: "https://github.com/dev865077/depix-mvp/issues/610",
      },
      discussion: { url: "https://github.com/dev865077/depix-mvp/discussions/612" },
      planningStatus: "request_changes",
      blockingRoles: ["technical", "risk"],
      blockedByDependencies: false,
      roundCount: 4,
      maxRounds: 4,
      humanIssueBody: "## Outcome\nTight body.",
      currentManagedSection: "canonical_state: `issue_planning_request_changes`",
      childIssues: [],
      reviewerMemos: [],
      latestConclusionBody: "Final recommendation: `Request changes`",
      humanReplies: [],
      automatedReplies: [],
      discussionContext: "Full bounded discussion context",
      blockingDependencies: ["#606"],
    });
    const section = buildIssuePlanningModeratorAutomationSection({
      model: "gpt-test",
      provider: "openai_responses",
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/612",
      planningStatus: "request_changes",
      blockingRoles: ["technical"],
      blockingDependencies: ["#606"],
      roundCount: 4,
      decision: "issue_blocked_external_dependency",
      summary: "Final decision blocked.",
      resolutionSummary: "The issue is good but still depends on #606.",
      createdChildIssues: [],
    });
    const status = buildIssuePlanningModeratorStatusComment({
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/612",
      planningStatus: "request_changes",
      blockingRoles: ["technical"],
      blockingDependencies: ["#606"],
      roundCount: 4,
      decision: "issue_blocked_external_dependency",
      createdChildIssues: [],
    });
    const reply = buildIssuePlanningModeratorReplyBody({
      decision: "issue_split_required",
      replyBody: "The root should split into child issues.",
      createdChildIssues: [{ number: 401, title: "sub-issue: child" }],
      blockingDependencies: [],
    });

    expect(prompt).toContain("Round limit reached: true");
    expect(prompt).toContain("Completed refinement rounds: 4");
    expect(section).toContain("moderator_decision: `issue_blocked_external_dependency`");
    expect(section).toContain("canonical_state: `issue_blocked_external_dependency`");
    expect(status).toContain("Final moderator decision: `issue_blocked_external_dependency`");
    expect(reply).toContain("<!-- ai-issue-planning-moderator:openai -->");
    expect(reply).toContain("final_decision: `issue_split_required`");
  });

  it("validates the final moderator decision contract", () => {
    const blocked = assertValidIssuePlanningModeratorDecision(JSON.stringify({
      summary: "Blocked on #606.",
      updatedTitle: "track: moderador final",
      updatedBodyHumanSection: "## Outcome\nBlocked on #606.",
      resolutionSummary: "The artifact is good but still depends on #606.",
      replyBody: "The issue is now blocked only on #606.",
      decision: "issue_blocked_external_dependency",
      failureReason: null,
      blockingDependencies: ["#606"],
      newChildIssues: [],
    }));

    expect(blocked.decision).toBe("issue_blocked_external_dependency");
    expect(() => assertValidIssuePlanningModeratorDecision(JSON.stringify({
      summary: "Split.",
      updatedTitle: "track: moderador final",
      updatedBodyHumanSection: "## Outcome\nSplit.",
      resolutionSummary: "Split required.",
      replyBody: "Split this root.",
      decision: "issue_split_required",
      failureReason: null,
      blockingDependencies: [],
      newChildIssues: [],
    }))).toThrow("at least one child issue");
    expect(buildIssuePlanningModeratorStatusComment({
      discussionUrl: "https://github.com/dev865077/depix-mvp/discussions/612",
      planningStatus: "request_changes",
      blockingRoles: ["product"],
      blockingDependencies: [],
      roundCount: 4,
      decision: "issue_rejected_or_duplicate",
      createdChildIssues: [],
    })).toContain("canonical_state: `issue_rejected_or_duplicate`");
  });

  it("marks refinement round 4 as the final common round before moderator escalation", () => {
    const prompt = buildIssueRefinementUserPrompt({
      repository: "dev865077/depix-mvp",
      issue: {
        number: 609,
        title: "Propagar contexto",
        html_url: "https://github.com/dev865077/depix-mvp/issues/609",
      },
      discussion: { url: "https://github.com/dev865077/depix-mvp/discussions/610" },
      planningStatus: "request_changes",
      blockingRoles: ["scrum"],
      blockedByDependencies: false,
      roundCount: 4,
      maxRounds: 4,
      humanIssueBody: "## Outcome\nTight body.",
      currentManagedSection: "canonical_state: `issue_planning_request_changes`",
      childIssues: [],
      reviewerMemos: [],
      latestConclusionBody: "Final recommendation: `Request changes`",
      humanReplies: [],
      automatedReplies: [],
      discussionContext: "Latest planning conclusion thread",
      blockingDependencies: [],
    });

    expect(prompt).toContain("current_round: 4");
    expect(prompt).toContain("max_rounds: 4");
    expect(prompt).toContain("rounds_remaining: 0");
    expect(prompt).toContain("is_last_common_round_before_moderator: true");
    expect(prompt).toContain("final common refinement round before moderator escalation");
  });

  it("builds the exact workflow dispatch request used to rerun planning", () => {
    const request = buildIssuePlanningRerunDispatchRequest("dev865077/depix-mvp", 292, " main ");

    expect(request.url).toBe(
      "https://api.github.com/repos/dev865077/depix-mvp/actions/workflows/ai-issue-planning-review.yml/dispatches",
    );
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(request.init.body)).toEqual({
      ref: "main",
      inputs: { discussion_number: "292" },
    });
  });

  it("builds the exact workflow dispatch request used to triage child issues", () => {
    const request = buildIssueTriageDispatchRequest("dev865077/depix-mvp", 301, " main ");

    expect(request.url).toBe(
      "https://api.github.com/repos/dev865077/depix-mvp/actions/workflows/ai-issue-triage.yml/dispatches",
    );
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(request.init.body)).toEqual({
      ref: "main",
      inputs: { issue_number: "301" },
    });
  });

  it("runs refinement end to end and reruns planning automatically", async () => {
    const calls = [];
    const runtime = {
      readPrompt: async () => "system prompt",
      fetchIssue: async () => ({
        number: 291,
        title: "epic: release 0.1 readiness",
        body: "## Outcome\nTight body.",
        html_url: "https://github.com/dev865077/depix-mvp/issues/291",
      }),
      fetchIssueComments: async () => [],
      fetchDiscussionByNumber: async () => ({
        id: "discussion-292",
        number: 292,
        title: "[Issue #291] track: release 0.1 readiness",
        body: "Issue origem: #291",
        url: "https://github.com/dev865077/depix-mvp/discussions/292",
        comments: {
          nodes: [
            {
              id: "planning-final-1",
              author: { login: "github-actions[bot]" },
              createdAt: "2026-04-21T12:00:00Z",
              body: "<!-- ai-issue-planning-final:openai -->\nFinal recommendation: `Request changes`",
              replies: { nodes: [] },
            },
          ],
        },
      }),
      updateIssue: async (...args) => {
        calls.push(["updateIssue", ...args]);
      },
      upsertIssuePlanningStatusComment: async (...args) => {
        calls.push(["status", ...args]);
      },
      createDiscussionReply: async (...args) => {
        calls.push(["reply", ...args]);
      },
      createOrReuseChildIssues: async (_repo, _parentIssue, childIssueDrafts) => childIssueDrafts.map((draft, index) => ({
        number: 301 + index,
        title: draft.title,
      })),
      dispatchIssueTriage: async (...args) => {
        calls.push(["child-triage", ...args]);
      },
      dispatchPlanningRerun: async (...args) => {
        calls.push(["rerun", ...args]);
      },
      generateWithOpenAI: async () => JSON.stringify({
        summary: "Split the track into executable child issues.",
        updatedTitle: "epic: release 0.1 readiness",
        updatedBodyHumanSection: "## Outcome\nNow explicit.\n\n## Acceptance\n- Evidence exists.",
        resolutionSummary: "The issue now names acceptance and child slices.",
        replyBody: "The issue body now has explicit acceptance and child issues, so planning should rerun.",
        recommendedNextState: "issue_refinement_in_progress",
        shouldRerunPlanning: true,
        isNoOp: false,
        failureReason: null,
        blockingDependencies: [],
        newChildIssues: [
          {
            title: "sub-issue: validate callback proof",
            body: "Track callback proof ownership.",
          },
        ],
      }),
      generateWithEndpoint: async () => {
        throw new Error("should not call endpoint");
      },
    };

    const result = await runIssueRefinementWorkflow({
      repository: "dev865077/depix-mvp",
      owner: "dev865077",
      name: "depix-mvp",
      workflowRef: "main",
      promptPath: ".github/prompts/ai-issue-refinement.md",
      provider: "openai_responses",
      model: "gpt-test",
      maxRounds: 3,
      dispatchInput: {
        issueNumber: 291,
        discussionNumber: 292,
        planningStatus: "request_changes",
        blockingRoles: ["technical"],
        blockedByDependencies: false,
      },
    }, runtime);

    expect(result.nextPhase).toBe("rerun_planning");
    expect(calls[0][0]).toBe("status");
    expect(calls.find((call) => call[0] === "updateIssue")[2]).toBe(291);
    expect(calls.find((call) => call[0] === "updateIssue")[3]).toBe("track: release 0.1 readiness");
    expect(calls.find((call) => call[0] === "updateIssue")[4]).toContain("#301 - sub-issue: validate callback proof");
    expect(calls.find((call) => call[0] === "reply")).toEqual([
      "reply",
      "discussion-292",
      "planning-final-1",
      expect.stringContaining("Issue refinement update"),
    ]);
    expect(calls.find((call) => call[0] === "child-triage")).toEqual([
      "child-triage",
      "dev865077/depix-mvp",
      301,
      "main",
    ]);
    expect(calls.find((call) => call[0] === "rerun")).toEqual([
      "rerun",
      "dev865077/depix-mvp",
      292,
      "main",
    ]);
  });

  it("keeps parent planning rerun when child triage dispatch fails", async () => {
    const calls = [];
    const runtime = {
      readPrompt: async () => "system prompt",
      fetchIssue: async () => ({
        number: 291,
        title: "track: release 0.1 readiness",
        body: "## Outcome\nTight body.",
        html_url: "https://github.com/dev865077/depix-mvp/issues/291",
      }),
      fetchIssueComments: async () => [],
      fetchDiscussionByNumber: async () => ({
        id: "discussion-292",
        number: 292,
        title: "[Issue #291] track: release 0.1 readiness",
        body: "Issue origem: #291",
        url: "https://github.com/dev865077/depix-mvp/discussions/292",
        comments: {
          nodes: [
            {
              id: "planning-final-1",
              author: { login: "github-actions[bot]" },
              createdAt: "2026-04-21T12:00:00Z",
              body: "<!-- ai-issue-planning-final:openai -->\nFinal recommendation: `Request changes`",
              replies: { nodes: [] },
            },
          ],
        },
      }),
      updateIssue: async (...args) => {
        calls.push(["updateIssue", ...args]);
      },
      upsertIssuePlanningStatusComment: async (...args) => {
        calls.push(["status", ...args]);
      },
      createDiscussionReply: async (...args) => {
        calls.push(["reply", ...args]);
      },
      createOrReuseChildIssues: async () => [{ number: 301, title: "sub-issue: validate callback proof" }],
      dispatchIssueTriage: async (...args) => {
        calls.push(["child-triage", ...args]);
        throw new Error("dispatch unavailable");
      },
      dispatchPlanningRerun: async (...args) => {
        calls.push(["rerun", ...args]);
      },
      generateWithOpenAI: async () => JSON.stringify({
        summary: "Split the track into executable child issues.",
        updatedTitle: "track: release 0.1 readiness",
        updatedBodyHumanSection: "## Outcome\nNow explicit.",
        resolutionSummary: "The issue now has a child issue.",
        replyBody: "The issue body now has child issues, so planning should rerun.",
        recommendedNextState: "issue_refinement_in_progress",
        shouldRerunPlanning: true,
        isNoOp: false,
        failureReason: null,
        blockingDependencies: [],
        newChildIssues: [
          {
            title: "sub-issue: validate callback proof",
            body: "Track callback proof ownership.",
          },
        ],
      }),
      generateWithEndpoint: async () => {
        throw new Error("should not call endpoint");
      },
    };

    const result = await runIssueRefinementWorkflow({
      repository: "dev865077/depix-mvp",
      owner: "dev865077",
      name: "depix-mvp",
      workflowRef: "main",
      promptPath: ".github/prompts/ai-issue-refinement.md",
      provider: "openai_responses",
      model: "gpt-test",
      maxRounds: 3,
      dispatchInput: {
        issueNumber: 291,
        discussionNumber: 292,
        planningStatus: "request_changes",
        blockingRoles: ["risk"],
        blockedByDependencies: false,
      },
    }, runtime);

    expect(result.nextPhase).toBe("rerun_planning");
    expect(calls.find((call) => call[0] === "child-triage")).toEqual([
      "child-triage",
      "dev865077/depix-mvp",
      301,
      "main",
    ]);
    expect(calls.find((call) => call[0] === "rerun")).toEqual([
      "rerun",
      "dev865077/depix-mvp",
      292,
      "main",
    ]);
  });

  it("invokes the final moderator after the refinement round limit and marks the issue ready for Codex", async () => {
    const calls = [];
    const runtime = {
      readPrompt: async (path) => path.includes("moderator") ? "moderator prompt" : "refinement prompt",
      fetchIssue: async () => ({
        number: 610,
        title: "track: moderador final",
        body: "## Outcome\nTight body.",
        html_url: "https://github.com/dev865077/depix-mvp/issues/610",
      }),
      fetchIssueComments: async () => [],
      fetchDiscussionByNumber: async () => ({
        id: "discussion-612",
        number: 612,
        title: "[Issue #610] track: moderador final",
        body: "Issue origem: #610",
        url: "https://github.com/dev865077/depix-mvp/discussions/612",
        comments: {
          nodes: [
            {
              id: "planning-final-4",
              author: { login: "github-actions[bot]" },
              createdAt: "2026-04-21T12:00:03Z",
              body: "<!-- ai-issue-planning-final:openai -->\nFinal recommendation: `Request changes`",
              replies: {
                nodes: Array.from({ length: 4 }, (_, index) => ({
                  author: { login: "github-actions[bot]" },
                  createdAt: `2026-04-21T12:00:1${index}Z`,
                  body: "<!-- ai-issue-refinement:openai -->\n## Issue refinement update",
                })),
              },
            },
          ],
        },
      }),
      updateIssue: async (...args) => {
        calls.push(["updateIssue", ...args]);
      },
      upsertIssuePlanningStatusComment: async (...args) => {
        calls.push(["status", ...args]);
      },
      createDiscussionReply: async (...args) => {
        calls.push(["reply", ...args]);
      },
      createOrReuseChildIssues: async () => [],
      dispatchIssueTriage: async (...args) => {
        calls.push(["child-triage", ...args]);
      },
      dispatchPlanningRerun: async (...args) => {
        calls.push(["rerun", ...args]);
      },
      generateWithOpenAI: async () => {
        throw new Error("should not call refinement generator");
      },
      generateWithChatCompletions: async () => {
        throw new Error("should not call refinement generator");
      },
      generateModeratorWithOpenAI: async () => JSON.stringify({
        summary: "Final decision: ready for Codex.",
        updatedTitle: "track: moderador final",
        updatedBodyHumanSection: "## Outcome\nReady.",
        resolutionSummary: "The issue is now implementation-ready as one artifact.",
        replyBody: "The final moderator decision is that this issue is ready for Codex.",
        decision: "issue_ready_for_codex",
        failureReason: null,
        blockingDependencies: [],
        newChildIssues: [],
      }),
      generateModeratorWithChatCompletions: async () => {
        throw new Error("should not call chat moderator");
      },
      generateWithEndpoint: async () => {
        throw new Error("should not call endpoint");
      },
    };

    const result = await runIssueRefinementWorkflow({
      repository: "dev865077/depix-mvp",
      owner: "dev865077",
      name: "depix-mvp",
      workflowRef: "main",
      promptPath: ".github/prompts/ai-issue-refinement.md",
      moderatorPromptPath: ".github/prompts/ai-issue-planning-moderator.md",
      provider: "openai_responses",
      model: "gpt-test",
      maxRounds: 4,
      dispatchInput: {
        issueNumber: 610,
        discussionNumber: 612,
        planningStatus: "request_changes",
        blockingRoles: ["technical"],
        blockedByDependencies: false,
      },
    }, runtime);

    expect(result.nextPhase).toBe("moderated");
    expect(calls.find((call) => call[0] === "updateIssue")[4]).toContain("canonical_state: `issue_ready_for_codex`");
    expect(calls.find((call) => call[0] === "status")[3]).toContain("Final moderator decision: `issue_ready_for_codex`");
    expect(calls.find((call) => call[0] === "reply")).toEqual([
      "reply",
      "discussion-612",
      "planning-final-4",
      expect.stringContaining("Final planning moderator decision"),
    ]);
    expect(calls.some((call) => call[0] === "rerun")).toBe(false);
  });

  it("reuses an existing final moderator decision idempotently on rerun", async () => {
    const calls = [];
    const runtime = {
      readPrompt: async () => {
        throw new Error("should not read prompts after final moderator decision");
      },
      fetchIssue: async () => ({
        number: 610,
        title: "track: moderador final",
        body: [
          "## Outcome",
          "Ready.",
          "",
          "<!-- ai-issue-automation:start -->",
          "## Canonical automation handoff",
          "canonical_state: `issue_ready_for_codex`",
          "moderator_decision: `issue_ready_for_codex`",
          "blocking_dependencies: ``",
          "<!-- ai-issue-automation:end -->",
        ].join("\n"),
        html_url: "https://github.com/dev865077/depix-mvp/issues/610",
      }),
      fetchIssueComments: async () => [],
      fetchDiscussionByNumber: async () => ({
        id: "discussion-612",
        number: 612,
        title: "[Issue #610] track: moderador final",
        body: "Issue origem: #610",
        url: "https://github.com/dev865077/depix-mvp/discussions/612",
        comments: {
          nodes: [
            {
              id: "planning-final-4",
              author: { login: "github-actions[bot]" },
              createdAt: "2026-04-21T12:00:00Z",
              body: "<!-- ai-issue-planning-final:openai -->\nFinal recommendation: `Request changes`",
              replies: { nodes: [] },
            },
          ],
        },
      }),
      updateIssue: async (...args) => {
        calls.push(["updateIssue", ...args]);
      },
      upsertIssuePlanningStatusComment: async (...args) => {
        calls.push(["status", ...args]);
      },
      createDiscussionReply: async (...args) => {
        calls.push(["reply", ...args]);
      },
      createOrReuseChildIssues: async () => {
        throw new Error("should not create child issues");
      },
      dispatchIssueTriage: async (...args) => {
        calls.push(["child-triage", ...args]);
      },
      dispatchPlanningRerun: async (...args) => {
        calls.push(["rerun", ...args]);
      },
      generateWithOpenAI: async () => {
        throw new Error("should not call refinement generator");
      },
      generateWithChatCompletions: async () => {
        throw new Error("should not call refinement generator");
      },
      generateModeratorWithOpenAI: async () => {
        throw new Error("should not call moderator generator");
      },
      generateModeratorWithChatCompletions: async () => {
        throw new Error("should not call moderator generator");
      },
      generateWithEndpoint: async () => {
        throw new Error("should not call endpoint");
      },
    };

    const result = await runIssueRefinementWorkflow({
      repository: "dev865077/depix-mvp",
      owner: "dev865077",
      name: "depix-mvp",
      workflowRef: "main",
      promptPath: ".github/prompts/ai-issue-refinement.md",
      moderatorPromptPath: ".github/prompts/ai-issue-planning-moderator.md",
      provider: "openai_responses",
      model: "gpt-test",
      maxRounds: 4,
      dispatchInput: {
        issueNumber: 610,
        discussionNumber: 612,
        planningStatus: "request_changes",
        blockingRoles: ["technical"],
        blockedByDependencies: false,
      },
    }, runtime);

    expect(result.nextPhase).toBe("moderated_reused");
    expect(calls.find((call) => call[0] === "status")[3]).toContain("Final moderator decision: `issue_ready_for_codex`");
    expect(calls.some((call) => call[0] === "updateIssue")).toBe(false);
    expect(calls.some((call) => call[0] === "reply")).toBe(false);
  });

  it("keeps the issue blocked when explicit dependencies remain", async () => {
    const calls = [];
    const runtime = {
      readPrompt: async () => "system prompt",
      fetchIssue: async () => ({
        number: 291,
        title: "track: release 0.1 readiness",
        body: "## Outcome\nTight body.",
        html_url: "https://github.com/dev865077/depix-mvp/issues/291",
      }),
      fetchIssueComments: async () => [],
      fetchDiscussionByNumber: async () => ({
        id: "discussion-292",
        number: 292,
        title: "[Issue #291] track: release 0.1 readiness",
        body: "Issue origem: #291",
        url: "https://github.com/dev865077/depix-mvp/discussions/292",
        comments: {
          nodes: [
            {
              id: "planning-final-1",
              author: { login: "github-actions[bot]" },
              createdAt: "2026-04-21T12:00:00Z",
              body: "<!-- ai-issue-planning-final:openai -->\nFinal recommendation: `Blocked`",
              replies: { nodes: [] },
            },
          ],
        },
      }),
      updateIssue: async (...args) => {
        calls.push(["updateIssue", ...args]);
      },
      upsertIssuePlanningStatusComment: async (...args) => {
        calls.push(["status", ...args]);
      },
      createDiscussionReply: async (...args) => {
        calls.push(["reply", ...args]);
      },
      createOrReuseChildIssues: async () => [],
      dispatchIssueTriage: async (...args) => {
        calls.push(["child-triage", ...args]);
      },
      dispatchPlanningRerun: async (...args) => {
        calls.push(["rerun", ...args]);
      },
      generateWithOpenAI: async () => JSON.stringify({
        summary: "The issue is now clear but still depends on #144.",
        updatedTitle: "track: release 0.1 readiness",
        updatedBodyHumanSection: "## Outcome\nExplicit.\n\nDepends on #144.",
        resolutionSummary: "Internal planning debt is gone; upstream dependency still remains.",
        replyBody: "The issue is now clear enough, but it still waits on #144 before planning can approve execution.",
        recommendedNextState: "issue_planning_blocked",
        shouldRerunPlanning: false,
        isNoOp: false,
        failureReason: null,
        blockingDependencies: ["#144"],
        newChildIssues: [],
      }),
      generateWithEndpoint: async () => {
        throw new Error("should not call endpoint");
      },
    };

    const result = await runIssueRefinementWorkflow({
      repository: "dev865077/depix-mvp",
      owner: "dev865077",
      name: "depix-mvp",
      workflowRef: "main",
      promptPath: ".github/prompts/ai-issue-refinement.md",
      provider: "openai_responses",
      model: "gpt-test",
      maxRounds: 3,
      dispatchInput: {
        issueNumber: 291,
        discussionNumber: 292,
        planningStatus: "blocked",
        blockingRoles: ["risk"],
        blockedByDependencies: true,
      },
    }, runtime);

    expect(result.nextPhase).toBe("blocked");
    expect(calls.some((call) => call[0] === "child-triage")).toBe(false);
    expect(calls.some((call) => call[0] === "rerun")).toBe(false);
    expect(calls.find((call) => call[0] === "updateIssue")[4]).toContain("canonical_state: `issue_planning_blocked`");
  });
});
