/**
 * Focused tests for the issue refinement workflow.
 */
import { describe, expect, it } from "vitest";
import issueRefinementWorkflowText from "../.github/workflows/ai-issue-refinement.yml?raw";

import {
  assertValidIssueRefinementPlan,
  buildIssuePlanningRerunDispatchRequest,
  buildIssueTriageDispatchRequest,
  buildIssueRefinementAutomationSection,
  buildIssueRefinementReplyBody,
  buildIssueRefinementStatusComment,
  buildIssueRefinementUserPrompt,
  countIssueRefinementRounds,
  extractAutomationField,
  extractIssueAutomationSection,
  findLatestPlanningFinalComment,
  normalizeIssueArtifactTitle,
  parseIssueRefinementDispatchInput,
  parseIssueRefinementResponse,
  runIssueRefinementWorkflow,
} from "../scripts/ai-issue-refinement.mjs";

describe("ai issue refinement", () => {
  it("keeps the refinement workflow as a workflow_dispatch API lane", () => {
    expect(issueRefinementWorkflowText).toContain("workflow_dispatch:");
    expect(issueRefinementWorkflowText).toContain("actions: write");
    expect(issueRefinementWorkflowText).toContain("discussions: write");
    expect(issueRefinementWorkflowText).toContain("issues: write");
    expect(issueRefinementWorkflowText).toContain("AI_ISSUE_REFINEMENT_PROVIDER");
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
    expect(prompt).toContain("Latest specialist reviewer memos");
    expect(prompt).toContain("Vou quebrar isso em child issues.");
    expect(status).toContain("next_actor: `ai_issue_planning_review`");
    expect(status).toContain("next_action: `run_four_specialist_review`");
    expect(section).toContain("canonical_state: `issue_planning_blocked`");
    expect(section).toContain("next_actor: `dependency_owner`");
    expect(reply).toContain("created_child_issue: #301 - sub-issue: validate callback proof");
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
