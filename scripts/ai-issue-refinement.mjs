/**
 * Automated issue-refinement runner.
 *
 * This workflow receives non-approved planning outcomes, improves the issue via
 * GitHub API, replies in the latest planning conclusion thread, and optionally
 * reruns planning without waiting for a human.
 */
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildDiscussionHistoryContext,
  extractIssueNumberFromDiscussion,
  fetchReferencedChildIssues,
  parseReferencedIssueNumbers,
  stripIssueAutomationSection,
  upsertIssueAutomationSection,
} from "./ai-issue-planning-review.mjs";

const DISCUSSION_FINAL_COMMENT_MARKER = "<!-- ai-issue-planning-final:openai -->";
const ISSUE_PLANNING_STATUS_MARKER = "<!-- ai-issue-planning-status:openai -->";
const ISSUE_AUTOMATION_START_MARKER = "<!-- ai-issue-automation:start -->";
const ISSUE_AUTOMATION_END_MARKER = "<!-- ai-issue-automation:end -->";
const ISSUE_REFINEMENT_COMMENT_MARKER = "<!-- ai-issue-refinement:openai -->";
const CHILD_ISSUE_MARKER_PREFIX = "<!-- ai-issue-refinement-child:";
const ISSUE_PLANNING_WORKFLOW_FILE = "ai-issue-planning-review.yml";
const ISSUE_TRIAGE_WORKFLOW_FILE = "ai-issue-triage.yml";
const OPENAI_REQUEST_TIMEOUT_MS = 120000;
const MAX_OUTPUT_TOKENS = 2400;
const MAX_CHILD_ISSUES_PER_REFINEMENT = 4;
const MAX_TOTAL_CHILD_ISSUES_PER_ROOT = 12;
const MAX_ISSUE_BODY_CHARS = 9000;
const MAX_DISCUSSION_CONTEXT_CHARS = 18000;
const REASONING_EFFORT = "low";
const ISSUE_REFINEMENT_JSON_SCHEMA = {
  name: "issue_refinement_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "updatedTitle",
      "updatedBodyHumanSection",
      "resolutionSummary",
      "replyBody",
      "recommendedNextState",
      "shouldRerunPlanning",
      "isNoOp",
      "failureReason",
      "blockingDependencies",
      "newChildIssues",
    ],
    properties: {
      summary: { type: "string" },
      updatedTitle: { type: "string" },
      updatedBodyHumanSection: { type: "string" },
      resolutionSummary: { type: "string" },
      replyBody: { type: "string" },
      recommendedNextState: {
        type: "string",
        enum: ["issue_refinement_in_progress", "issue_planning_blocked"],
      },
      shouldRerunPlanning: { type: "boolean" },
      isNoOp: { type: "boolean" },
      failureReason: { type: ["string", "null"] },
      blockingDependencies: {
        type: "array",
        items: { type: "string" },
      },
      newChildIssues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body"],
          properties: {
            title: { type: "string" },
            body: { type: "string" },
          },
        },
      },
    },
  },
  strict: true,
};

function logOperationalEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function readRequiredEnv(key) {
  const value = process.env[key];

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value.trim();
}

function truncateText(value, maxLength) {
  if (!value) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n... [truncated]`;
}

async function readPrompt(promptPath) {
  try {
    return await fs.readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read AI issue refinement prompt file at ${promptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function githubRequest(url, init = {}) {
  const token = readRequiredEnv("GITHUB_TOKEN");
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function githubGraphqlRequest(query, variables = {}) {
  const token = readRequiredEnv("GITHUB_TOKEN");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GraphQL request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GitHub GraphQL request returned errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

function extractContentItemText(contentItem) {
  if (!contentItem || typeof contentItem !== "object") {
    return "";
  }

  if (typeof contentItem.text === "string" && contentItem.text.trim().length > 0) {
    return contentItem.text.trim();
  }

  if (
    contentItem.text
    && typeof contentItem.text === "object"
    && typeof contentItem.text.value === "string"
    && contentItem.text.value.trim().length > 0
  ) {
    return contentItem.text.value.trim();
  }

  if (typeof contentItem.output_text === "string" && contentItem.output_text.trim().length > 0) {
    return contentItem.output_text.trim();
  }

  return "";
}

function readOpenAIText(responseJson) {
  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim().length > 0) {
    return responseJson.output_text.trim();
  }

  const textParts = [];

  for (const outputItem of responseJson.output ?? []) {
    if (outputItem.type !== "message") {
      continue;
    }

    for (const contentItem of outputItem.content ?? []) {
      const extractedText = extractContentItemText(contentItem);

      if (extractedText) {
        textParts.push(extractedText);
      }
    }
  }

  return textParts.join("\n\n").trim();
}

function summarizeOpenAIResponse(responseJson) {
  return JSON.stringify({
    status: responseJson?.status ?? null,
    incompleteReason: responseJson?.incomplete_details?.reason ?? null,
    hasOutputText: typeof responseJson?.output_text === "string" && responseJson.output_text.trim().length > 0,
    outputItems: Array.isArray(responseJson?.output)
      ? responseJson.output.map((outputItem) => ({
        type: outputItem?.type ?? null,
        status: outputItem?.status ?? null,
        contentTypes: Array.isArray(outputItem?.content)
          ? outputItem.content.map((contentItem) => contentItem?.type ?? null)
          : [],
      }))
      : [],
  });
}

export function parseIssueRefinementDispatchInput(event) {
  const issueNumber = Number.parseInt(event?.inputs?.issue_number ?? "", 10);
  const discussionNumber = Number.parseInt(event?.inputs?.discussion_number ?? "", 10);
  const planningStatus = typeof event?.inputs?.planning_status === "string"
    ? event.inputs.planning_status.trim()
    : "";
  const blockingRoles = typeof event?.inputs?.blocking_roles === "string"
    ? event.inputs.blocking_roles
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const blockedByDependencies = String(event?.inputs?.blocked_by_dependencies ?? "").trim().toLowerCase() === "true";

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number for issue refinement: ${String(event?.inputs?.issue_number)}`);
  }

  if (!Number.isInteger(discussionNumber) || discussionNumber <= 0) {
    throw new Error(`Invalid discussion number for issue refinement: ${String(event?.inputs?.discussion_number)}`);
  }

  if (!["request_changes", "blocked", "approve"].includes(planningStatus)) {
    throw new Error(`Invalid planning status for issue refinement: ${String(event?.inputs?.planning_status)}`);
  }

  return {
    issueNumber,
    discussionNumber,
    planningStatus,
    blockingRoles,
    blockedByDependencies,
  };
}

export function extractIssueAutomationSection(body) {
  if (typeof body !== "string" || body.trim().length === 0) {
    return "";
  }

  const match = body.match(
    new RegExp(`${ISSUE_AUTOMATION_START_MARKER}\\n?([\\s\\S]*?)\\n?${ISSUE_AUTOMATION_END_MARKER}`),
  );

  return match?.[1]?.trim() ?? "";
}

export function extractAutomationField(section, key) {
  if (typeof section !== "string" || typeof key !== "string" || section.trim().length === 0 || key.trim().length === 0) {
    return "";
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quotedMatch = section.match(new RegExp(`^${escapedKey}:\\s*\`([^\\n]*)\`\\s*$`, "im"));

  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  const plainMatch = section.match(new RegExp(`^${escapedKey}:\\s*(.+)\\s*$`, "im"));

  return plainMatch?.[1]?.trim() ?? "";
}

function isAutomatedPlanningFinalComment(comment) {
  const authorLogin = comment?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && typeof comment?.body === "string"
    && comment.body.trimStart().startsWith(DISCUSSION_FINAL_COMMENT_MARKER);
}

function isAutomatedPlanningFinalReply(reply) {
  const authorLogin = reply?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && typeof reply?.body === "string"
    && reply.body.trimStart().startsWith(DISCUSSION_FINAL_COMMENT_MARKER);
}

function isAutomatedRefinementReply(reply) {
  const authorLogin = reply?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && typeof reply?.body === "string"
    && reply.body.trimStart().startsWith(ISSUE_REFINEMENT_COMMENT_MARKER);
}

export function findLatestPlanningFinalComment(discussion) {
  return [...(discussion?.comments?.nodes ?? [])]
    .reverse()
    .find((comment) => isAutomatedPlanningFinalComment(comment)) ?? null;
}

export function extractLatestPlanningReviewerMemos(discussion) {
  const latestByRole = new Map();
  const roleOrder = ["product", "technical", "scrum", "risk"];

  for (const comment of discussion?.comments?.nodes ?? []) {
    const authorLogin = comment?.author?.login;

    if (authorLogin !== "github-actions" && authorLogin !== "github-actions[bot]") {
      continue;
    }

    if (typeof comment?.body !== "string" || !comment.body.includes("<!-- ai-issue-planning-role:")) {
      continue;
    }

    const roleMatch = comment.body.match(/<!--\s*ai-issue-planning-role:(product|technical|scrum|risk)\s*-->/i);

    if (!roleMatch?.[1]) {
      continue;
    }

    latestByRole.set(roleMatch[1].toLowerCase(), {
      role: roleMatch[1].toLowerCase(),
      createdAt: comment.createdAt ?? "unknown",
      body: comment.body ?? "",
    });
  }

  return roleOrder
    .filter((role) => latestByRole.has(role))
    .map((role) => latestByRole.get(role));
}

export function countIssueRefinementRounds(discussion) {
  const latestFinalComment = findLatestPlanningFinalComment(discussion);

  if (!latestFinalComment) {
    return 0;
  }

  const threadReplies = latestFinalComment.replies?.nodes ?? [];
  const latestPlanningReplyIndex = [...threadReplies]
    .map((reply, index) => ({ reply, index }))
    .filter(({ reply }) => isAutomatedPlanningFinalReply(reply))
    .at(-1)?.index ?? -1;

  return threadReplies
    .slice(latestPlanningReplyIndex + 1)
    .filter((reply) => isAutomatedRefinementReply(reply))
    .length;
}

function extractLatestPlanningConclusionThread(discussion) {
  const finalComment = findLatestPlanningFinalComment(discussion);
  const replies = finalComment?.replies?.nodes ?? [];
  const automatedReplies = replies.filter((reply) => isAutomatedRefinementReply(reply));
  const humanReplies = replies.filter((reply) => !isAutomatedRefinementReply(reply));

  return {
    finalComment,
    humanReplies,
    automatedReplies,
  };
}

function formatDiscussionReplies(replies) {
  if (!Array.isArray(replies) || replies.length === 0) {
    return "[none]";
  }

  return replies.map((reply) => [
    `### ${reply.author?.login ?? "unknown"} @ ${reply.createdAt ?? "unknown"}`,
    truncateText(reply.body ?? "[empty]", 1600),
  ].join("\n")).join("\n\n");
}

function formatReviewerMemos(memos) {
  if (!Array.isArray(memos) || memos.length === 0) {
    return "[none]";
  }

  return memos.map((memo) => [
    `### ${memo.role} @ ${memo.createdAt ?? "unknown"}`,
    truncateText(memo.body ?? "[empty]", 1800),
  ].join("\n")).join("\n\n");
}

function formatChildIssues(childIssues) {
  if (!Array.isArray(childIssues) || childIssues.length === 0) {
    return "[none]";
  }

  return childIssues.map((issue) => [
    `### #${issue.number} - ${issue.title}`,
    `state: ${String(issue.state ?? "unknown").toLowerCase()}`,
    `labels: ${(issue.labels ?? []).map((label) => label.name).join(", ") || "(none)"}`,
    "",
    truncateText(issue.body ?? "[no description provided]", 1400),
  ].join("\n")).join("\n\n");
}

export function buildIssueRefinementUserPrompt(input) {
  const blockingRoles = Array.isArray(input.blockingRoles) ? input.blockingRoles : [];
  const blockingDependencies = Array.isArray(input.blockingDependencies) ? input.blockingDependencies : [];

  return [
    `Repository: ${input.repository}`,
    `Root issue: #${input.issue.number} - ${input.issue.title}`,
    `Issue URL: ${input.issue.html_url ?? input.issue.url ?? "[unknown]"}`,
    `Planning discussion: ${input.discussion.url ?? "[unknown]"}`,
    `Planning status in: ${input.planningStatus}`,
    `Blocking roles: ${blockingRoles.join(",") || "(none)"}`,
    `Blocked by dependencies input: ${String(input.blockedByDependencies)}`,
    `Current refinement round count: ${input.roundCount}`,
    "",
    "## Human issue body",
    truncateText(input.humanIssueBody, MAX_ISSUE_BODY_CHARS) || "[no human issue body]",
    "",
    "## Current managed automation section",
    truncateText(input.currentManagedSection, 5000) || "[none]",
    "",
    "## Referenced child issues",
    formatChildIssues(input.childIssues),
    "",
    "## Latest specialist reviewer memos",
    formatReviewerMemos(input.reviewerMemos),
    "",
    "## Latest automated planning conclusion",
    truncateText(input.latestConclusionBody, 2500) || "[none]",
    "",
    "## Human replies in the latest conclusion thread",
    formatDiscussionReplies(input.humanReplies),
    "",
    "## Prior automated refinement replies in the latest conclusion thread",
    formatDiscussionReplies(input.automatedReplies),
    "",
    "## Full bounded discussion context",
    truncateText(input.discussionContext, MAX_DISCUSSION_CONTEXT_CHARS) || "[none]",
    "",
    "## Current automation goal",
    "Refine this issue automatically until it is ready for Codex, unless the remaining blockers are purely explicit upstream dependencies.",
    ...(blockingDependencies.length > 0
      ? [
        "",
        "## Existing blocking dependencies",
        ...blockingDependencies.map((dependency) => `- ${dependency}`),
      ]
      : []),
  ].join("\n");
}

function extractJsonObject(rawValue) {
  if (typeof rawValue !== "string") {
    return rawValue;
  }

  const trimmedValue = rawValue.trim();

  if (trimmedValue.startsWith("{") && trimmedValue.endsWith("}")) {
    return trimmedValue;
  }

  const fencedMatch = trimmedValue.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmedValue.indexOf("{");
  const lastBrace = trimmedValue.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmedValue.slice(firstBrace, lastBrace + 1);
  }

  return trimmedValue;
}

export function parseIssueRefinementResponse(rawValue) {
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    if (rawValue.result && typeof rawValue.result === "object" && !Array.isArray(rawValue.result)) {
      return rawValue.result;
    }

    return rawValue;
  }

  const jsonText = extractJsonObject(rawValue);

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Issue refinement agent returned invalid JSON: ${error instanceof Error ? error.message : String(error)}. Payload excerpt: ${truncateText(String(jsonText), 800)}`,
    );
  }
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

export function normalizeChildIssueDrafts(childIssues) {
  if (!Array.isArray(childIssues)) {
    return [];
  }

  return childIssues
    .map((childIssue) => ({
      title: String(childIssue?.title ?? "").trim(),
      body: String(childIssue?.body ?? "").trim(),
    }))
    .filter((childIssue) => childIssue.title && childIssue.body)
    .slice(0, MAX_CHILD_ISSUES_PER_REFINEMENT);
}

export function extractRefinementChildParentNumber(issue) {
  const body = typeof issue?.body === "string" ? issue.body : "";
  const markerMatch = body.match(/<!--\s*ai-issue-refinement-child:([0-9]+):/i);
  const parentLineMatch = body.match(/^Parent issue:\s*#([0-9]+)\b/im);
  const parentNumber = Number.parseInt(markerMatch?.[1] ?? parentLineMatch?.[1] ?? "", 10);

  return Number.isInteger(parentNumber) && parentNumber > 0 ? parentNumber : null;
}

export function isRefinementChildIssue(issue) {
  return extractRefinementChildParentNumber(issue) !== null;
}

export function countRefinementChildrenForParent(openIssues, parentIssueNumber) {
  if (!Array.isArray(openIssues) || !Number.isInteger(parentIssueNumber) || parentIssueNumber <= 0) {
    return 0;
  }

  return openIssues
    .filter((issue) => extractRefinementChildParentNumber(issue) === parentIssueNumber)
    .length;
}

export function selectChildIssueDraftsForCreation(parentIssue, openIssues, childIssueDrafts) {
  if (isRefinementChildIssue(parentIssue)) {
    return [];
  }

  const existingChildIssueCount = countRefinementChildrenForParent(openIssues, parentIssue?.number);
  const availableSlots = Math.max(0, MAX_TOTAL_CHILD_ISSUES_PER_ROOT - existingChildIssueCount);

  return normalizeChildIssueDrafts(childIssueDrafts).slice(0, availableSlots);
}

export function normalizeIssueArtifactTitle(title, totalChildIssueCount) {
  const trimmedTitle = String(title ?? "").trim();

  if (!trimmedTitle) {
    throw new Error("Issue refinement must return a non-empty updatedTitle.");
  }

  if (/^\s*epic\s*:/i.test(trimmedTitle) && totalChildIssueCount < 2) {
    return trimmedTitle.replace(/^\s*epic\s*:/i, "track:");
  }

  return trimmedTitle;
}

export function assertValidIssueRefinementPlan(rawPlan) {
  const plan = parseIssueRefinementResponse(rawPlan);
  const recommendedNextState = String(plan?.recommendedNextState ?? "").trim();
  const shouldRerunPlanning = plan?.shouldRerunPlanning === true;
  const isNoOp = plan?.isNoOp === true;
  const blockingDependencies = normalizeStringArray(plan?.blockingDependencies);
  const newChildIssues = normalizeChildIssueDrafts(plan?.newChildIssues);

  if (!["issue_refinement_in_progress", "issue_planning_blocked"].includes(recommendedNextState)) {
    throw new Error(`Issue refinement must return a valid recommendedNextState. Received: ${String(plan?.recommendedNextState)}`);
  }

  if (recommendedNextState === "issue_planning_blocked" && shouldRerunPlanning) {
    throw new Error("Issue refinement cannot request a planning rerun when the next state is issue_planning_blocked.");
  }

  const normalizedPlan = {
    summary: String(plan?.summary ?? "").trim(),
    updatedTitle: String(plan?.updatedTitle ?? "").trim(),
    updatedBodyHumanSection: String(plan?.updatedBodyHumanSection ?? "").trim(),
    resolutionSummary: String(plan?.resolutionSummary ?? "").trim(),
    replyBody: String(plan?.replyBody ?? "").trim(),
    recommendedNextState,
    shouldRerunPlanning,
    isNoOp,
    failureReason: plan?.failureReason == null ? null : String(plan.failureReason).trim(),
    blockingDependencies,
    newChildIssues,
  };

  if (!normalizedPlan.summary) {
    throw new Error("Issue refinement must return a non-empty summary.");
  }

  if (!normalizedPlan.updatedTitle) {
    throw new Error("Issue refinement must return a non-empty updatedTitle.");
  }

  if (!normalizedPlan.updatedBodyHumanSection) {
    throw new Error("Issue refinement must return a non-empty updatedBodyHumanSection.");
  }

  if (!normalizedPlan.resolutionSummary) {
    throw new Error("Issue refinement must return a non-empty resolutionSummary.");
  }

  if (!normalizedPlan.replyBody) {
    throw new Error("Issue refinement must return a non-empty replyBody.");
  }

  if (normalizedPlan.isNoOp && !normalizedPlan.failureReason && !normalizedPlan.blockingDependencies.length) {
    throw new Error("Issue refinement no-op responses must explain the failureReason or blockingDependencies.");
  }

  return normalizedPlan;
}

function resolveIssueRefinementState(phase) {
  if (phase === "active") {
    return {
      canonicalState: "issue_refinement_in_progress",
      nextActor: "issue_refinement_agent",
      nextAction: "refine_issue_and_reply_to_planning_conclusion",
      blockedByDependencies: false,
    };
  }

  if (phase === "rerun_planning") {
    return {
      canonicalState: "issue_refinement_in_progress",
      nextActor: "ai_issue_planning_review",
      nextAction: "run_four_specialist_review",
      blockedByDependencies: false,
    };
  }

  if (phase === "blocked") {
    return {
      canonicalState: "issue_planning_blocked",
      nextActor: "dependency_owner",
      nextAction: "wait_for_dependencies",
      blockedByDependencies: true,
    };
  }

  return {
    canonicalState: "issue_planning_request_changes",
    nextActor: "issue_refinement_agent",
    nextAction: "manual_recovery_required",
    blockedByDependencies: false,
  };
}

function collectSubIssueLinkFallbacks(createdChildIssues) {
  if (!Array.isArray(createdChildIssues)) {
    return [];
  }

  return createdChildIssues
    .filter((issue) => issue?.subIssueLink?.linked === false)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      reason: String(issue.subIssueLink.reason ?? "native sub-issue link was not created"),
    }));
}

export function buildIssueRefinementAutomationSection(input) {
  const state = resolveIssueRefinementState(input.phase);
  const createdChildIssues = Array.isArray(input.createdChildIssues) ? input.createdChildIssues : [];
  const subIssueLinkFallbacks = collectSubIssueLinkFallbacks(createdChildIssues);
  const blockingRoles = Array.isArray(input.blockingRoles) ? input.blockingRoles : [];
  const blockingDependencies = normalizeStringArray(input.blockingDependencies);

  return [
    "## Canonical automation handoff",
    "",
    "This section is maintained by the GitHub automation lane. Update the human issue text above it; the workflow rewrites only this managed section.",
    "",
    `model: \`${input.model}\``,
    `provider: \`${input.provider}\``,
    `planning_discussion: ${input.discussionUrl}`,
    `planning_status_in: \`${input.planningStatus}\``,
    `canonical_state: \`${state.canonicalState}\``,
    `next_actor: \`${state.nextActor}\``,
    `next_action: \`${state.nextAction}\``,
    "ready_for_codex: `false`",
    "ready_for_branch: `false`",
    "ready_for_pr: `false`",
    `blocked_by_dependencies: \`${String(state.blockedByDependencies)}\``,
    `blocking_roles: \`${blockingRoles.join(",")}\``,
    `blocking_dependencies: \`${blockingDependencies.join(" | ")}\``,
    `refinement_round_count: \`${String(input.roundCount)}\``,
    "",
    "## Refinement synthesis",
    "",
    input.summary,
    "",
    "## Resolution summary",
    "",
    input.resolutionSummary,
    "",
    "## Created child issues",
    ...(createdChildIssues.length > 0
      ? createdChildIssues.map((issue) => `- #${issue.number} - ${issue.title}`)
      : ["- None."]),
    "",
    "## Native sub-issue link fallbacks",
    ...(subIssueLinkFallbacks.length > 0
      ? subIssueLinkFallbacks.map((issue) => `- #${issue.number} - ${issue.reason}`)
      : ["- None."]),
    "",
    "## Codex handoff",
    state.nextActor === "ai_issue_planning_review"
      ? "Codex must still wait. The issue refinement agent already updated the artifact and requeued planning automatically."
      : state.nextActor === "dependency_owner"
        ? "Codex must still wait. The artifact is refined, but explicit upstream dependencies still need to land before implementation can start."
        : "Codex must still wait. Automated refinement stopped before the issue became ready for implementation.",
  ].join("\n");
}

export function buildIssueRefinementStatusComment(input) {
  const state = resolveIssueRefinementState(input.phase);
  const subIssueLinkFallbacks = collectSubIssueLinkFallbacks(input.createdChildIssues);
  const blockingRoles = Array.isArray(input.blockingRoles) ? input.blockingRoles : [];
  const blockingDependencies = normalizeStringArray(input.blockingDependencies);

  return [
    ISSUE_PLANNING_STATUS_MARKER,
    "## AI Issue Planning Status",
    "",
    `Planning Discussion: ${input.discussionUrl}`,
    `Planning status in: \`${input.planningStatus}\``,
    "",
    "## Estado canonico",
    `canonical_state: \`${state.canonicalState}\``,
    `next_actor: \`${state.nextActor}\``,
    `next_action: \`${state.nextAction}\``,
    "ready_for_codex: `false`",
    "ready_for_branch: `false`",
    "ready_for_pr: `false`",
    `blocked_by_dependencies: \`${String(state.blockedByDependencies)}\``,
    `blocking_roles: \`${blockingRoles.join(",")}\``,
    `blocking_dependencies: \`${blockingDependencies.join(" | ")}\``,
    `refinement_round_count: \`${String(input.roundCount)}\``,
    `native_sub_issue_link_fallback_count: \`${String(subIssueLinkFallbacks.length)}\``,
  ].join("\n");
}

export function buildIssueRefinementReplyBody(input) {
  const createdChildIssues = Array.isArray(input.createdChildIssues) ? input.createdChildIssues : [];
  const subIssueLinkFallbacks = collectSubIssueLinkFallbacks(createdChildIssues);
  const blockingDependencies = normalizeStringArray(input.blockingDependencies);
  const state = resolveIssueRefinementState(input.phase);

  return [
    ISSUE_REFINEMENT_COMMENT_MARKER,
    "## Issue refinement update",
    "",
    input.replyBody,
    "",
    "## Automation result",
    `- next_actor: \`${state.nextActor}\``,
    `- next_action: \`${state.nextAction}\``,
    `- should_rerun_planning: \`${String(input.phase === "rerun_planning")}\``,
    ...(createdChildIssues.length > 0
      ? createdChildIssues.map((issue) => `- created_child_issue: #${issue.number} - ${issue.title}`)
      : ["- created_child_issue: none"]),
    ...(subIssueLinkFallbacks.length > 0
      ? subIssueLinkFallbacks.map((issue) => `- native_sub_issue_link_fallback: #${issue.number} - ${issue.reason}`)
      : []),
    ...(blockingDependencies.length > 0
      ? blockingDependencies.map((dependency) => `- blocking_dependency: ${dependency}`)
      : []),
  ].join("\n");
}

function buildChildIssueMarker(parentIssueNumber, title) {
  return `${CHILD_ISSUE_MARKER_PREFIX}${parentIssueNumber}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")} -->`;
}

export function buildGitHubSubIssueLinkRequest(repoFullName, parentIssueNumber, subIssueId) {
  if (typeof repoFullName !== "string" || !/^[^/]+\/[^/]+$/.test(repoFullName)) {
    throw new Error(`Invalid repository for sub-issue link: ${String(repoFullName)}`);
  }

  if (!Number.isInteger(parentIssueNumber) || parentIssueNumber <= 0) {
    throw new Error(`Invalid parent issue number for sub-issue link: ${String(parentIssueNumber)}`);
  }

  if (!Number.isInteger(subIssueId) || subIssueId <= 0) {
    throw new Error(`Invalid sub-issue id for sub-issue link: ${String(subIssueId)}`);
  }

  return {
    url: `https://api.github.com/repos/${repoFullName}/issues/${parentIssueNumber}/sub_issues`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sub_issue_id: subIssueId }),
    },
  };
}

async function linkGitHubSubIssue(repoFullName, parentIssueNumber, childIssue) {
  return linkGitHubSubIssueWithRequest(githubRequest, repoFullName, parentIssueNumber, childIssue);
}

async function linkGitHubSubIssueWithRequest(requestGitHub, repoFullName, parentIssueNumber, childIssue) {
  if (!Number.isInteger(childIssue?.id)) {
    const message = `Cannot link child issue #${childIssue?.number ?? "unknown"} as a native sub-issue because the REST issue id is missing.`;

    logOperationalEvent("ai_issue_refinement.sub_issue.link_fallback", {
      parentIssueNumber,
      childIssueNumber: childIssue?.number ?? null,
      reason: message,
    });

    return { linked: false, reason: message };
  }

  const request = buildGitHubSubIssueLinkRequest(repoFullName, parentIssueNumber, childIssue.id);

  try {
    await requestGitHub(request.url, request.init);
    logOperationalEvent("ai_issue_refinement.sub_issue.linked", {
      parentIssueNumber,
      childIssueNumber: childIssue.number,
    });
    return { linked: true, reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logOperationalEvent("ai_issue_refinement.sub_issue.link_fallback", {
      parentIssueNumber,
      childIssueNumber: childIssue.number,
      reason: message,
    });
    return { linked: false, reason: message };
  }
}

function appendCreatedChildIssueReferences(body, createdChildIssues) {
  const trimmedBody = String(body ?? "").trim();

  if (!Array.isArray(createdChildIssues) || createdChildIssues.length === 0) {
    return trimmedBody;
  }

  const missingReferences = createdChildIssues.filter((issue) => !trimmedBody.includes(`#${issue.number}`));

  if (missingReferences.length === 0) {
    return trimmedBody;
  }

  const referencesSection = [
    "## Child issues",
    ...missingReferences.map((issue) => `- [ ] #${issue.number} - ${issue.title}`),
  ].join("\n");

  return trimmedBody
    ? `${trimmedBody}\n\n${referencesSection}`
    : referencesSection;
}

async function fetchIssue(repoFullName, issueNumber) {
  return githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}`);
}

async function fetchIssueComments(repoFullName, issueNumber) {
  return githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments?per_page=100`);
}

async function fetchAllOpenIssues(repoFullName) {
  return fetchAllIssues(repoFullName, "open");
}

async function fetchAllIssues(repoFullName, state = "open") {
  const issues = [];
  const normalizedState = state === "all" ? "all" : "open";

  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(
      `https://api.github.com/repos/${repoFullName}/issues?state=${normalizedState}&per_page=100&page=${page}`,
    );

    if (!Array.isArray(batch) || batch.length === 0) {
      return issues;
    }

    issues.push(...batch.filter((issue) => !issue.pull_request));

    if (batch.length < 100) {
      return issues;
    }
  }
}

async function fetchDiscussionByNumber(owner, name, discussionNumber) {
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        discussion(number: $number) {
          id
          number
          title
          body
          url
          comments(first: 80) {
            nodes {
              id
              body
              createdAt
              author {
                login
              }
              replies(first: 80) {
                nodes {
                  id
                  body
                  createdAt
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(query, { owner, name, number: discussionNumber });
  const discussion = data?.repository?.discussion;

  if (!discussion) {
    throw new Error(`Discussion #${discussionNumber} was not found in ${owner}/${name}.`);
  }

  return discussion;
}

async function createDiscussionReply(discussionId, replyToId, body) {
  const mutation = `
    mutation($discussionId: ID!, $replyToId: ID!, $body: String!) {
      addDiscussionComment(input: {
        discussionId: $discussionId,
        replyToId: $replyToId,
        body: $body
      }) {
        comment {
          id
          url
        }
      }
    }
  `;
  await githubGraphqlRequest(mutation, { discussionId, replyToId, body });
}

async function upsertIssuePlanningStatusComment(repoFullName, issueNumber, body) {
  const comments = await fetchIssueComments(repoFullName, issueNumber);
  const existingComment = comments.find((comment) => {
    const authorLogin = comment?.user?.login;

    return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
      && typeof comment?.body === "string"
      && comment.body.trimStart().startsWith(ISSUE_PLANNING_STATUS_MARKER);
  });

  if (existingComment) {
    await githubRequest(`https://api.github.com/repos/${repoFullName}/issues/comments/${existingComment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    return;
  }

  await githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

async function updateIssue(repoFullName, issueNumber, title, body) {
  await githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
}

async function createOrReuseChildIssues(repoFullName, parentIssue, childIssueDrafts) {
  return createOrReuseChildIssuesWithRequest(githubRequest, repoFullName, parentIssue, childIssueDrafts);
}

export async function createOrReuseChildIssuesWithRequest(requestGitHub, repoFullName, parentIssue, childIssueDrafts) {
  if (!Array.isArray(childIssueDrafts) || childIssueDrafts.length === 0) {
    return [];
  }

  const allIssues = [];

  for (let page = 1; ; page += 1) {
    const batch = await requestGitHub(
      `https://api.github.com/repos/${repoFullName}/issues?state=all&per_page=100&page=${page}`,
    );

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    allIssues.push(...batch.filter((issue) => !issue.pull_request));

    if (batch.length < 100) {
      break;
    }
  }

  const boundedChildIssueDrafts = selectChildIssueDraftsForCreation(parentIssue, allIssues, childIssueDrafts);

  if (boundedChildIssueDrafts.length === 0) {
    logOperationalEvent("ai_issue_refinement.child_issue.creation_skipped", {
      parentIssueNumber: parentIssue?.number,
      reason: isRefinementChildIssue(parentIssue) ? "child_issue_cannot_create_children" : "root_child_issue_limit_reached",
      totalChildIssueLimit: MAX_TOTAL_CHILD_ISSUES_PER_ROOT,
    });
    return [];
  }

  const existingByTitle = new Map(
    allIssues
      .filter((issue) => String(issue.state ?? "open").toLowerCase() === "open")
      .map((issue) => [String(issue.title ?? "").trim().toLowerCase(), issue]),
  );
  const createdIssues = [];

  for (const childIssue of boundedChildIssueDrafts) {
    const titleKey = childIssue.title.toLowerCase();
    const existingIssue = existingByTitle.get(titleKey);

    if (existingIssue) {
      const subIssueLink = await linkGitHubSubIssueWithRequest(requestGitHub, repoFullName, parentIssue.number, existingIssue);
      createdIssues.push({ ...existingIssue, subIssueLink });
      continue;
    }

    const marker = buildChildIssueMarker(parentIssue.number, childIssue.title);
    const body = [
      marker,
      `Parent issue: #${parentIssue.number} - ${parentIssue.title}`,
      "",
      childIssue.body,
    ].join("\n");
    const createdIssue = await requestGitHub(`https://api.github.com/repos/${repoFullName}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: childIssue.title,
        body,
      }),
    });

    existingByTitle.set(titleKey, createdIssue);
    const subIssueLink = await linkGitHubSubIssueWithRequest(requestGitHub, repoFullName, parentIssue.number, createdIssue);
    createdIssues.push({ ...createdIssue, subIssueLink });
  }

  return createdIssues;
}

export function buildIssuePlanningRerunDispatchRequest(repoFullName, discussionNumber, ref) {
  const trimmedRef = typeof ref === "string" ? ref.trim() : "";

  if (typeof repoFullName !== "string" || !/^[^/]+\/[^/]+$/.test(repoFullName)) {
    throw new Error(`Invalid repository for planning rerun dispatch: ${String(repoFullName)}`);
  }

  if (!Number.isInteger(discussionNumber) || discussionNumber <= 0) {
    throw new Error(`Invalid discussion number for planning rerun dispatch: ${String(discussionNumber)}`);
  }

  if (!trimmedRef) {
    throw new Error("Invalid ref for planning rerun dispatch.");
  }

  return {
    url: `https://api.github.com/repos/${repoFullName}/actions/workflows/${ISSUE_PLANNING_WORKFLOW_FILE}/dispatches`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: trimmedRef,
        inputs: {
          discussion_number: String(discussionNumber),
        },
      }),
    },
  };
}

async function dispatchPlanningRerun(repoFullName, discussionNumber, ref) {
  const request = buildIssuePlanningRerunDispatchRequest(repoFullName, discussionNumber, ref);

  await githubRequest(request.url, request.init);
}

export function buildIssueTriageDispatchRequest(repoFullName, issueNumber, ref) {
  const trimmedRef = typeof ref === "string" ? ref.trim() : "";

  if (typeof repoFullName !== "string" || !/^[^/]+\/[^/]+$/.test(repoFullName)) {
    throw new Error(`Invalid repository for child triage dispatch: ${String(repoFullName)}`);
  }

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number for child triage dispatch: ${String(issueNumber)}`);
  }

  if (!trimmedRef) {
    throw new Error("Invalid ref for child triage dispatch.");
  }

  return {
    url: `https://api.github.com/repos/${repoFullName}/actions/workflows/${ISSUE_TRIAGE_WORKFLOW_FILE}/dispatches`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: trimmedRef,
        inputs: {
          issue_number: String(issueNumber),
        },
      }),
    },
  };
}

async function dispatchIssueTriage(repoFullName, issueNumber, ref) {
  const request = buildIssueTriageDispatchRequest(repoFullName, issueNumber, ref);

  await githubRequest(request.url, request.init);
}

async function dispatchChildIssueTriages(runtime, repoFullName, parentIssueNumber, childIssues, ref) {
  const failures = [];

  for (const childIssue of childIssues) {
    try {
      await runtime.dispatchIssueTriage(repoFullName, childIssue.number, ref);
      logOperationalEvent("ai_issue_refinement.child_triage.dispatched", {
        parentIssueNumber,
        childIssueNumber: childIssue.number,
        ref,
      });
    } catch (error) {
      failures.push({
        issueNumber: childIssue.number,
        message: error instanceof Error ? error.message : String(error),
      });
      logOperationalEvent("ai_issue_refinement.child_triage.dispatch_failed", {
        parentIssueNumber,
        childIssueNumber: childIssue.number,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return failures;
}

async function generateIssueRefinementWithOpenAI(systemPrompt, userPrompt, model) {
  const apiKey = readRequiredEnv("OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      reasoning: {
        effort: REASONING_EFFORT,
      },
      text: {
        format: {
          type: "json_schema",
          ...ISSUE_REFINEMENT_JSON_SCHEMA,
        },
      },
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }],
        },
      ],
    }),
    signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI issue refinement request failed for model ${model} (${response.status}): ${body}`);
  }

  const responseJson = await response.json();
  const responseText = readOpenAIText(responseJson);

  if (!responseText) {
    throw new Error(`OpenAI returned an empty issue refinement payload. Response summary: ${summarizeOpenAIResponse(responseJson)}`);
  }

  return responseText;
}

async function generateIssueRefinementWithChatCompletions(systemPrompt, userPrompt, model) {
  const apiKey = readRequiredEnv("OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: {
        type: "json_schema",
        json_schema: ISSUE_REFINEMENT_JSON_SCHEMA,
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI chat-completions issue refinement request failed for model ${model} (${response.status}): ${body}`);
  }

  const responseJson = await response.json();
  const message = responseJson?.choices?.[0]?.message;
  const refusal = typeof message?.refusal === "string" ? message.refusal.trim() : "";
  const content = typeof message?.content === "string" ? message.content.trim() : "";

  if (refusal) {
    throw new Error(`OpenAI chat-completions issue refinement refused the request: ${refusal}`);
  }

  if (!content) {
    throw new Error(`OpenAI chat-completions returned empty issue refinement content: ${JSON.stringify(responseJson)}`);
  }

  return content;
}

async function generateIssueRefinementWithEndpoint(endpoint, payload) {
  const bearerToken = process.env.AI_ISSUE_REFINEMENT_BEARER_TOKEN?.trim();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Issue refinement endpoint failed (${response.status}): ${body}`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

/**
 * @typedef {object} IssueRefinementRuntime
 * @property {(promptPath: string) => Promise<string>} readPrompt
 * @property {(repoFullName: string, issueNumber: number) => Promise<any>} fetchIssue
 * @property {(repoFullName: string, issueNumber: number) => Promise<any[]>} fetchIssueComments
 * @property {(owner: string, name: string, discussionNumber: number) => Promise<any>} fetchDiscussionByNumber
 * @property {(repoFullName: string, issueNumber: number, title: string, body: string) => Promise<void>} updateIssue
 * @property {(repoFullName: string, issueNumber: number, body: string) => Promise<void>} upsertIssuePlanningStatusComment
 * @property {(discussionId: string, replyToId: string, body: string) => Promise<void>} createDiscussionReply
 * @property {(repoFullName: string, parentIssue: any, childIssueDrafts: Array<{ title: string, body: string }>) => Promise<any[]>} createOrReuseChildIssues
 * @property {(repoFullName: string, issueNumber: number, ref: string) => Promise<void>} dispatchIssueTriage
 * @property {(repoFullName: string, discussionNumber: number, ref: string) => Promise<void>} dispatchPlanningRerun
 * @property {(systemPrompt: string, userPrompt: string, model: string) => Promise<any>} generateWithOpenAI
 * @property {(systemPrompt: string, userPrompt: string, model: string) => Promise<any>} generateWithChatCompletions
 * @property {(endpoint: string, payload: Record<string, unknown>) => Promise<any>} generateWithEndpoint
 */

const ISSUE_REFINEMENT_RUNTIME = {
  readPrompt,
  fetchIssue,
  fetchIssueComments,
  fetchDiscussionByNumber,
  updateIssue,
  upsertIssuePlanningStatusComment,
  createDiscussionReply,
  createOrReuseChildIssues,
  dispatchIssueTriage,
  dispatchPlanningRerun,
  generateWithOpenAI: generateIssueRefinementWithOpenAI,
  generateWithChatCompletions: generateIssueRefinementWithChatCompletions,
  generateWithEndpoint: generateIssueRefinementWithEndpoint,
};

export async function runIssueRefinementWorkflow(input, runtime = ISSUE_REFINEMENT_RUNTIME) {
  const {
    repository,
    owner,
    name,
    workflowRef,
    promptPath,
    provider,
    model,
    maxRounds,
    dispatchInput,
  } = input;
  const {
    issueNumber,
    discussionNumber,
    planningStatus,
    blockingRoles,
    blockedByDependencies,
  } = dispatchInput;

  const [issue, discussion] = await Promise.all([
    runtime.fetchIssue(repository, issueNumber),
    runtime.fetchDiscussionByNumber(owner, name, discussionNumber),
  ]);
  const linkedIssueNumber = extractIssueNumberFromDiscussion(discussion);

  if (linkedIssueNumber !== issue.number) {
    throw new Error(`Issue refinement discussion mismatch: Discussion #${discussion.number} points to issue #${linkedIssueNumber ?? "unknown"}, expected #${issue.number}.`);
  }

  const roundCount = countIssueRefinementRounds(discussion);

  if (roundCount >= maxRounds) {
    const statusBody = buildIssueRefinementStatusComment({
      phase: "failed",
      discussionUrl: discussion.url,
      planningStatus,
      blockingRoles,
      blockingDependencies: [],
      roundCount,
    });
    const managedSection = buildIssueRefinementAutomationSection({
      phase: "failed",
      model: model || "n/a",
      provider,
      discussionUrl: discussion.url,
      planningStatus,
      blockingRoles,
      blockingDependencies: [],
      roundCount,
      summary: "Automated issue refinement hit the configured round limit.",
      resolutionSummary: "The workflow stopped rerunning itself to avoid an infinite silent loop. Manual recovery is required.",
      createdChildIssues: [],
    });

    await runtime.updateIssue(
      repository,
      issue.number,
      issue.title,
      upsertIssueAutomationSection(issue.body ?? "", managedSection),
    );
    await runtime.upsertIssuePlanningStatusComment(repository, issue.number, statusBody);
    throw new Error(`Issue refinement reached max rounds (${maxRounds}) for issue #${issue.number}.`);
  }

  await runtime.upsertIssuePlanningStatusComment(
    repository,
    issue.number,
    buildIssueRefinementStatusComment({
      phase: "active",
      discussionUrl: discussion.url,
      planningStatus,
      blockingRoles,
      blockingDependencies: [],
      roundCount: roundCount + 1,
    }),
  );

  const currentManagedSection = extractIssueAutomationSection(issue.body ?? "");
  const humanIssueBody = stripIssueAutomationSection(issue.body ?? "");
  const referencedIssueNumbers = parseReferencedIssueNumbers(humanIssueBody, issue.number);
  const childIssues = await fetchReferencedChildIssues(repository, referencedIssueNumbers);
  const {
    finalComment,
    humanReplies,
    automatedReplies,
  } = extractLatestPlanningConclusionThread(discussion);

  if (!finalComment?.id) {
    throw new Error(`Issue refinement requires the latest planning conclusion thread on Discussion #${discussion.number}.`);
  }

  const blockingDependencies = extractAutomationField(currentManagedSection, "blocking_dependencies")
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);
  const userPrompt = buildIssueRefinementUserPrompt({
    repository,
    issue,
    discussion,
    planningStatus,
    blockingRoles,
    blockedByDependencies,
    roundCount: roundCount + 1,
    humanIssueBody,
    currentManagedSection,
    childIssues,
    reviewerMemos: extractLatestPlanningReviewerMemos(discussion),
    latestConclusionBody: finalComment.body ?? "",
    humanReplies,
    automatedReplies,
    discussionContext: buildDiscussionHistoryContext(discussion),
    blockingDependencies,
  });
  const systemPrompt = await runtime.readPrompt(promptPath);

  let rawPlan;

  if (provider === "endpoint") {
    const endpoint = readRequiredEnv("AI_ISSUE_REFINEMENT_ENDPOINT");

    rawPlan = await runtime.generateWithEndpoint(endpoint, {
      repository,
      issue_number: issue.number,
      discussion_number: discussion.number,
      workflow_ref: workflowRef,
      planning_status: planningStatus,
      blocking_roles: blockingRoles,
      blocked_by_dependencies: blockedByDependencies,
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
    });
  } else if (provider === "openai_responses") {
    if (!model) {
      throw new Error("OPENAI_ISSUE_REFINEMENT_MODEL is required when provider=openai_responses.");
    }

    rawPlan = await runtime.generateWithOpenAI(systemPrompt, userPrompt, model);
  } else if (provider === "openai_chat_completions") {
    if (!model) {
      throw new Error("OPENAI_ISSUE_REFINEMENT_MODEL is required when provider=openai_chat_completions.");
    }

    rawPlan = await runtime.generateWithChatCompletions(systemPrompt, userPrompt, model);
  } else {
    throw new Error(`Unsupported AI_ISSUE_REFINEMENT_PROVIDER: ${provider}`);
  }

  const plan = assertValidIssueRefinementPlan(rawPlan);
  const createdChildIssues = await runtime.createOrReuseChildIssues(repository, issue, plan.newChildIssues);
  const finalHumanBody = appendCreatedChildIssueReferences(plan.updatedBodyHumanSection, createdChildIssues);
  const totalChildIssueCount = parseReferencedIssueNumbers(finalHumanBody, issue.number).length;
  const normalizedTitle = normalizeIssueArtifactTitle(plan.updatedTitle, totalChildIssueCount);
  const nextPhase = plan.shouldRerunPlanning ? "rerun_planning" : plan.recommendedNextState === "issue_planning_blocked" ? "blocked" : "failed";
  const managedSection = buildIssueRefinementAutomationSection({
    phase: nextPhase,
    model: model || "external-endpoint",
    provider,
    discussionUrl: discussion.url,
    planningStatus,
    blockingRoles,
    blockingDependencies: plan.blockingDependencies,
    roundCount: roundCount + 1,
    summary: plan.summary,
    resolutionSummary: plan.resolutionSummary,
    createdChildIssues,
  });

  await runtime.updateIssue(
    repository,
    issue.number,
    normalizedTitle,
    upsertIssueAutomationSection(finalHumanBody, managedSection),
  );
  await runtime.upsertIssuePlanningStatusComment(
    repository,
    issue.number,
    buildIssueRefinementStatusComment({
      phase: nextPhase,
      discussionUrl: discussion.url,
      planningStatus,
      blockingRoles,
      blockingDependencies: plan.blockingDependencies,
      roundCount: roundCount + 1,
      createdChildIssues,
    }),
  );
  await runtime.createDiscussionReply(
    discussion.id,
    finalComment.id,
    buildIssueRefinementReplyBody({
      phase: nextPhase,
      replyBody: plan.replyBody,
      createdChildIssues,
      blockingDependencies: plan.blockingDependencies,
    }),
  );

  const childTriageDispatchFailures = await dispatchChildIssueTriages(
    runtime,
    repository,
    issue.number,
    createdChildIssues,
    workflowRef,
  );

  if (plan.shouldRerunPlanning) {
    await runtime.dispatchPlanningRerun(repository, discussion.number, workflowRef);
    logOperationalEvent("ai_issue_refinement.planning_rerun.dispatched", {
      issueNumber: issue.number,
      discussionNumber: discussion.number,
      ref: workflowRef,
    });
  }

  logOperationalEvent("ai_issue_refinement.completed", {
    issueNumber: issue.number,
    discussionNumber: discussion.number,
    phase: nextPhase,
    createdChildIssueCount: createdChildIssues.length,
    nativeSubIssueLinkFallbackCount: collectSubIssueLinkFallbacks(createdChildIssues).length,
    childTriageDispatchFailureCount: childTriageDispatchFailures.length,
    shouldRerunPlanning: plan.shouldRerunPlanning,
    blockedDependencyCount: plan.blockingDependencies.length,
  });

  if (!plan.shouldRerunPlanning && nextPhase === "failed") {
    throw new Error(plan.failureReason || "Issue refinement could not advance the issue automatically.");
  }

  return {
    plan,
    createdChildIssues,
    subIssueLinkFallbacks: collectSubIssueLinkFallbacks(createdChildIssues),
    normalizedTitle,
    nextPhase,
  };
}

async function main() {
  const eventPath = readRequiredEnv("GITHUB_EVENT_PATH");
  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const [owner, name] = repository.split("/");
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const dispatchInput = parseIssueRefinementDispatchInput(event);
  const promptPath = process.env.AI_ISSUE_REFINEMENT_PROMPT_PATH?.trim() || ".github/prompts/ai-issue-refinement.md";
  const provider = process.env.AI_ISSUE_REFINEMENT_PROVIDER?.trim() || "openai_chat_completions";
  const model = process.env.OPENAI_ISSUE_REFINEMENT_MODEL?.trim() || "";
  const workflowRef = process.env.GITHUB_REF_NAME?.trim()
    || process.env.GITHUB_REF?.replace(/^refs\/heads\//, "")
    || event?.repository?.default_branch
    || "main";
  const maxRounds = Number.parseInt(process.env.AI_ISSUE_REFINEMENT_MAX_ROUNDS ?? "3", 10);

  if (!owner || !name) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  if (!Number.isInteger(maxRounds) || maxRounds <= 0) {
    throw new Error(`Invalid AI_ISSUE_REFINEMENT_MAX_ROUNDS: ${String(process.env.AI_ISSUE_REFINEMENT_MAX_ROUNDS)}`);
  }

  await runIssueRefinementWorkflow({
    repository,
    owner,
    name,
    workflowRef,
    promptPath,
    provider,
    model,
    maxRounds,
    dispatchInput,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
