/**
 * Automated issue triage runner.
 *
 * This workflow-side script reads one GitHub issue, asks OpenAI for a
 * structured triage decision, and keeps a single sticky comment on the issue.
 *
 * It deliberately does not create Discussions. When the issue needs planning,
 * this workflow dispatches the planning workflow, which owns the single
 * specialist Discussion lifecycle through the GitHub API.
 */
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TRIAGE_MARKER = "<!-- ai-issue-triage:openai -->";
const ISSUE_AUTOMATION_START_MARKER = "<!-- ai-issue-automation:start -->";
const ISSUE_AUTOMATION_END_MARKER = "<!-- ai-issue-automation:end -->";
const IMPACT_LEVELS = new Set(["baixo", "medio", "alto"]);
const ROUTE_DIRECT_PR = "direct_pr";
const ROUTE_DISCUSSION_BEFORE_PR = "discussion_before_pr";
const ROUTES = new Set([ROUTE_DIRECT_PR, ROUTE_DISCUSSION_BEFORE_PR]);
const EXECUTION_READINESS_LEVELS = new Set(["ready_now", "needs_discussion"]);
const MAX_ISSUE_BODY_CHARS = 5000;
const MAX_EXISTING_COMMENT_CHARS = 5000;
const MAX_OUTPUT_TOKENS = 25000;
const REASONING_EFFORT = "low";
const ISSUE_PLANNING_WORKFLOW_FILE = "ai-issue-planning-review.yml";

/**
 * @typedef {{
 *   summary: string,
 *   impact: "baixo" | "medio" | "alto",
 *   justification: string,
 *   route: "direct_pr" | "discussion_before_pr",
 *   executionReadiness: "ready_now" | "needs_discussion",
 *   needsDiscussion: boolean,
 *   reason: string,
 *   productView: string,
 *   technicalView: string,
 *   riskView: string,
 *   decision: string,
 *   discussionTitle: string,
 *   nextSteps: string[],
 * }} IssueTriagePlan
 */

/**
 * Assert that an environment variable exists.
 *
 * @param {string} key Environment variable name.
 * @returns {string} Trimmed variable value.
 */
function readRequiredEnv(key) {
  const value = process.env[key];

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value.trim();
}

/**
 * Read the configured model name and fail clearly on malformed values.
 *
 * The dedicated issue-triage model takes priority. When it is absent, the
 * repository reuses the already configured PR review model.
 *
 * @returns {string} Explicit model name.
 */
function readConfiguredModel() {
  const model = process.env.OPENAI_ISSUE_TRIAGE_MODEL?.trim() || process.env.OPENAI_PR_REVIEW_MODEL?.trim();

  if (!model) {
    throw new Error("Missing required environment variable: OPENAI_ISSUE_TRIAGE_MODEL or OPENAI_PR_REVIEW_MODEL.");
  }

  if (/\s/.test(model)) {
    throw new Error("Invalid OpenAI model name: model name cannot contain whitespace.");
  }

  return model;
}

/**
 * Truncate arbitrary text to a maximum size while preserving some context.
 *
 * @param {string | null | undefined} value Raw text value.
 * @param {number} maxLength Maximum allowed length.
 * @returns {string} Bounded text value.
 */
function truncateText(value, maxLength) {
  if (!value) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n... [truncated]`;
}

/**
 * Read the repository-owned prompt file for issue triage.
 *
 * @param {string} promptPath Relative path to the prompt file.
 * @returns {Promise<string>} Prompt content.
 */
async function readTriagePrompt(promptPath) {
  try {
    return await fs.readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read AI issue triage prompt file at ${promptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Perform an authenticated GitHub REST API request.
 *
 * @param {string} url Full GitHub API URL.
 * @param {RequestInit} [init] Extra fetch options.
 * @returns {Promise<any>} Parsed JSON response body.
 */
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

  const body = await response.text();

  return body.trim().length > 0 ? JSON.parse(body) : null;
}

/**
 * Fetch up to one page of issue comments in stable API order.
 *
 * A single sticky comment is enough for this workflow, so 100 comments gives
 * plenty of room without adding pagination complexity.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber GitHub issue number.
 * @returns {Promise<any[]>} Issue comments.
 */
async function fetchIssueComments(repoFullName, issueNumber) {
  return githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments?per_page=100`);
}

/**
 * Find the existing sticky triage comment generated by this workflow.
 *
 * @param {any[]} comments Issue comments.
 * @returns {any | null} Existing sticky comment or null.
 */
function findExistingTriageComment(comments) {
  return comments.find((comment) =>
    comment.user?.login === "github-actions[bot]" && typeof comment.body === "string" && comment.body.includes(TRIAGE_MARKER)) ?? null;
}

/**
 * Extract text from one OpenAI Responses content item.
 *
 * @param {any} contentItem One content item from the Responses payload.
 * @returns {string} Extracted text or an empty string.
 */
function extractContentItemText(contentItem) {
  if (!contentItem || typeof contentItem !== "object") {
    return "";
  }

  if (typeof contentItem.text === "string" && contentItem.text.trim().length > 0) {
    return contentItem.text.trim();
  }

  if (
    contentItem.text &&
    typeof contentItem.text === "object" &&
    typeof contentItem.text.value === "string" &&
    contentItem.text.value.trim().length > 0
  ) {
    return contentItem.text.value.trim();
  }

  if (typeof contentItem.output_text === "string" && contentItem.output_text.trim().length > 0) {
    return contentItem.output_text.trim();
  }

  return "";
}

/**
 * Summarize the OpenAI response envelope for failure diagnostics.
 *
 * @param {any} responseJson Raw OpenAI response JSON.
 * @returns {string} Compact JSON summary.
 */
function summarizeOpenAIResponse(responseJson) {
  const summary = {
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
  };

  return JSON.stringify(summary);
}

/**
 * Extract plain text from an OpenAI Responses payload.
 *
 * @param {any} responseJson Raw OpenAI response JSON.
 * @returns {string} Aggregated text output.
 */
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

/**
 * Ask OpenAI for a structured issue triage plan.
 *
 * @param {string} systemPrompt Repository-owned prompt.
 * @param {string} userPrompt Runtime issue payload.
 * @param {string} model Explicit model name.
 * @returns {Promise<string>} Raw JSON response text.
 */
async function generateIssueTriage(systemPrompt, userPrompt, model) {
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
          type: "json_object",
        },
      },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: systemPrompt,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userPrompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed for model ${model} (${response.status}): ${body}`);
  }

  const responseJson = await response.json();
  const triageText = readOpenAIText(responseJson);

  if (!triageText) {
    const responseSummary = summarizeOpenAIResponse(responseJson);

    if (responseJson?.status === "incomplete" && responseJson?.incomplete_details?.reason === "max_output_tokens") {
      throw new Error(`OpenAI exhausted max_output_tokens before producing issue triage JSON. Response summary: ${responseSummary}`);
    }

    throw new Error(`OpenAI returned an empty issue triage. Response summary: ${responseSummary}`);
  }

  return triageText;
}

/**
 * Parse JSON even when the model wraps it in a fenced code block.
 *
 * @param {string} rawText Raw model output.
 * @returns {any} Parsed JSON value.
 */
export function parseIssueTriageResponse(rawText) {
  const trimmedText = rawText.trim();
  const fencedMatch = trimmedText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fencedMatch ? fencedMatch[1].trim() : trimmedText;

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`AI issue triage did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate the model output before mutating GitHub state.
 *
 * @param {any} rawPlan Parsed model JSON output.
 * @returns {IssueTriagePlan} Safe triage plan.
 */
export function assertValidIssueTriagePlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new Error("AI issue triage must be a JSON object.");
  }

  const impact = typeof rawPlan.impact === "string" ? rawPlan.impact.trim().toLowerCase() : "";
  const route = typeof rawPlan.route === "string" ? rawPlan.route.trim() : "";
  const executionReadiness =
    typeof rawPlan.executionReadiness === "string"
      ? rawPlan.executionReadiness.trim().toLowerCase()
      : "";
  const needsDiscussion = rawPlan.needsDiscussion;
  const textFields = {
    summary: rawPlan.summary,
    justification: rawPlan.justification,
    reason: rawPlan.reason,
    productView: rawPlan.productView,
    technicalView: rawPlan.technicalView,
    riskView: rawPlan.riskView,
    decision: rawPlan.decision,
  };

  if (!IMPACT_LEVELS.has(impact)) {
    throw new Error(`AI issue triage returned invalid impact: ${String(rawPlan.impact)}`);
  }

  if (!ROUTES.has(route)) {
    throw new Error(`AI issue triage returned invalid route: ${String(rawPlan.route)}`);
  }

  if (!EXECUTION_READINESS_LEVELS.has(executionReadiness)) {
    throw new Error(`AI issue triage returned invalid executionReadiness: ${String(rawPlan.executionReadiness)}`);
  }

  if (typeof needsDiscussion !== "boolean") {
    throw new Error("AI issue triage must return needsDiscussion as a boolean.");
  }

  if (needsDiscussion !== (route === ROUTE_DISCUSSION_BEFORE_PR)) {
    throw new Error("AI issue triage returned inconsistent needsDiscussion and route.");
  }

  if (
    (executionReadiness === "ready_now" && route !== ROUTE_DIRECT_PR)
    || (executionReadiness === "needs_discussion" && route !== ROUTE_DISCUSSION_BEFORE_PR)
  ) {
    throw new Error("AI issue triage returned inconsistent executionReadiness and route.");
  }

  for (const [fieldName, value] of Object.entries(textFields)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`AI issue triage field is empty: ${fieldName}`);
    }
  }

  if (!Array.isArray(rawPlan.nextSteps) || rawPlan.nextSteps.length === 0 || rawPlan.nextSteps.length > 5) {
    throw new Error("AI issue triage must contain 1 to 5 nextSteps.");
  }

  const nextSteps = rawPlan.nextSteps.map((step) => {
    if (typeof step !== "string" || step.trim().length === 0) {
      throw new Error("AI issue triage nextSteps must contain non-empty strings.");
    }

    return step.trim();
  });

  const discussionTitle = typeof rawPlan.discussionTitle === "string" ? rawPlan.discussionTitle.trim() : "";

  if (route === ROUTE_DISCUSSION_BEFORE_PR && discussionTitle.length === 0) {
    throw new Error("AI issue triage must provide discussionTitle when route requires discussion.");
  }

  return {
    summary: rawPlan.summary.trim(),
    impact,
    justification: rawPlan.justification.trim(),
    route,
    executionReadiness,
    needsDiscussion,
    reason: rawPlan.reason.trim(),
    productView: rawPlan.productView.trim(),
    technicalView: rawPlan.technicalView.trim(),
    riskView: rawPlan.riskView.trim(),
    decision: rawPlan.decision.trim(),
    discussionTitle,
    nextSteps,
  };
}

/**
 * Build the markdown body for the sticky issue comment.
 *
 * @param {IssueTriagePlan} plan Safe triage plan.
 * @param {string} model Explicit model name.
 * @returns {string} Markdown comment body.
 */
export function buildIssueCommentBody(plan, model) {
  const routeLabel = plan.route === ROUTE_DIRECT_PR ? "PR direta" : "Discussion antes da PR";
  const needsPlanning = plan.route === ROUTE_DISCUSSION_BEFORE_PR;
  const canonicalState = needsPlanning ? "issue_needs_planning" : "issue_ready_for_codex";
  const nextActor = needsPlanning ? "ai_issue_planning_review" : "codex";
  const nextAction = needsPlanning ? "create_or_reuse_issue_planning_discussion" : "open_branch_and_pr";
  const planningSection = needsPlanning
    ? [
      "## Planning automatico",
      "",
      "A triage nao cria Discussion. Ela apenas publica este comentario canonico e despacha o workflow `AI Issue Planning Review`, que deve criar ou reutilizar uma unica Discussion canonica da issue, rodar os quatro especialistas e marcar a issue como pronta para Codex apenas quando houver aprovacao unanime.",
    ]
    : [];

  return [
    TRIAGE_MARKER,
    "## AI Issue Triage",
    "",
    `Model: \`${model}\``,
    `Impacto: \`${plan.impact}\``,
    `Fluxo recomendado: \`${routeLabel}\``,
    `Rota canonica: \`${plan.route}\``,
    `Prontidao de execucao: \`${plan.executionReadiness}\``,
    `needs_discussion: \`${String(plan.needsDiscussion)}\``,
    "",
    "## Estado canonico",
    `canonical_state: \`${canonicalState}\``,
    `next_actor: \`${nextActor}\``,
    `next_action: \`${nextAction}\``,
    `ready_for_codex: \`${String(!needsPlanning)}\``,
    `ready_for_branch: \`${String(!needsPlanning)}\``,
    `ready_for_pr: \`${String(!needsPlanning)}\``,
    "",
    "## Justificativa",
    plan.justification,
    "",
    "## Racional de rota",
    plan.reason,
    "",
    "## Debate",
    "",
    "### Produto e escopo",
    plan.productView,
    "",
    "### Tecnica e arquitetura",
    plan.technicalView,
    "",
    "### Risco e qualidade",
    plan.riskView,
    "",
    "## Decisao",
    plan.decision,
    "",
    "## Proximos passos",
    ...plan.nextSteps.map((step) => `- ${step}`),
    ...(planningSection.length > 0 ? ["", ...planningSection] : []),
  ].join("\n");
}

/**
 * Remove the automation-managed issue section while preserving the human body.
 *
 * @param {string | null | undefined} body Current issue body.
 * @returns {string} Body without the managed section.
 */
export function stripIssueAutomationSection(body) {
  if (typeof body !== "string" || body.length === 0) {
    return "";
  }

  const sectionPattern = new RegExp(
    `${ISSUE_AUTOMATION_START_MARKER}[\\s\\S]*?${ISSUE_AUTOMATION_END_MARKER}\\n?`,
    "g",
  );

  return body
    .replace(sectionPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Upsert the automation-managed issue section onto the human-authored body.
 *
 * @param {string | null | undefined} body Current issue body.
 * @param {string} managedSection Managed markdown section.
 * @returns {string} Final issue body.
 */
export function upsertIssueAutomationSection(body, managedSection) {
  const humanBody = stripIssueAutomationSection(body);
  const trimmedSection = typeof managedSection === "string" ? managedSection.trim() : "";

  if (!trimmedSection) {
    return humanBody;
  }

  const managedBlock = [
    ISSUE_AUTOMATION_START_MARKER,
    trimmedSection,
    ISSUE_AUTOMATION_END_MARKER,
  ].join("\n");

  return humanBody
    ? `${humanBody}\n\n${managedBlock}`
    : managedBlock;
}

/**
 * Build the automation-managed issue section published directly on the issue.
 *
 * @param {IssueTriagePlan} plan Safe triage plan.
 * @param {string} model Explicit model name.
 * @returns {string} Managed issue section.
 */
export function buildIssueAutomationSection(plan, model) {
  const needsPlanning = plan.route === ROUTE_DISCUSSION_BEFORE_PR;
  const canonicalState = needsPlanning ? "issue_needs_planning" : "issue_ready_for_codex";
  const nextActor = needsPlanning ? "ai_issue_planning_review" : "codex";
  const nextAction = needsPlanning ? "create_or_reuse_issue_planning_discussion" : "open_branch_and_pr";

  return [
    "## Canonical automation handoff",
    "",
    "This section is maintained by the GitHub automation lane. Update the human issue text above it; the workflow rewrites only this managed section.",
    "",
    `model: \`${model}\``,
    `canonical_state: \`${canonicalState}\``,
    `route: \`${plan.route}\``,
    `execution_readiness: \`${plan.executionReadiness}\``,
    `next_actor: \`${nextActor}\``,
    `next_action: \`${nextAction}\``,
    `ready_for_codex: \`${String(!needsPlanning)}\``,
    `ready_for_branch: \`${String(!needsPlanning)}\``,
    `ready_for_pr: \`${String(!needsPlanning)}\``,
    "",
    "### Summary",
    plan.summary,
    "",
    "### Route rationale",
    plan.reason,
    "",
    "### Product view",
    plan.productView,
    "",
    "### Technical view",
    plan.technicalView,
    "",
    "### Risk view",
    plan.riskView,
    "",
    "### Decision",
    plan.decision,
    "",
    "### Next steps",
    ...plan.nextSteps.map((step) => `- ${step}`),
  ].join("\n");
}

/**
 * Create or update the single sticky triage comment on the issue.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber GitHub issue number.
 * @param {string} body Final markdown comment body.
 * @returns {Promise<void>} Resolves when the comment is persisted.
 */
async function upsertIssueComment(repoFullName, issueNumber, body) {
  const comments = await fetchIssueComments(repoFullName, issueNumber);
  const existingComment = findExistingTriageComment(comments);

  if (existingComment) {
    await githubRequest(`https://api.github.com/repos/${repoFullName}/issues/comments/${existingComment.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });

    return;
  }

  await githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}

/**
 * Update the issue body with the latest automation-managed section.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber GitHub issue number.
 * @param {string | null | undefined} currentBody Current issue body.
 * @param {string} managedSection Automation-managed markdown section.
 * @returns {Promise<void>} Resolves when the issue body is persisted.
 */
async function updateIssueBodyAutomationSection(repoFullName, issueNumber, currentBody, managedSection) {
  const body = upsertIssueAutomationSection(currentBody, managedSection);

  await githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}

/**
 * Build the workflow_dispatch payload used to hand planning work to Actions.
 *
 * GitHub does not reliably trigger a second workflow from comments created by
 * `GITHUB_TOKEN`, so triage must dispatch planning explicitly when the route
 * requires a four-role planning Discussion.
 *
 * @param {number} issueNumber GitHub issue number.
 * @returns {{ issue_number: string }} Workflow input payload.
 */
export function buildIssuePlanningDispatchInputs(issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number for planning dispatch: ${String(issueNumber)}`);
  }

  return { issue_number: String(issueNumber) };
}

/**
 * Resolve the ref used for planning workflow dispatch.
 *
 * The normal Actions runtime exposes `GITHUB_REF_NAME`. Tests and unusual
 * events may not, so the repository default branch from the event is the safe
 * fallback before the final repository default of `main`.
 *
 * @param {any} event Raw GitHub event payload.
 * @param {NodeJS.ProcessEnv} [env] Environment source.
 * @returns {string} Branch or ref accepted by workflow_dispatch.
 */
export function resolveIssuePlanningDispatchRef(event, env = process.env) {
  return env.GITHUB_REF_NAME?.trim()
    || env.GITHUB_REF?.replace(/^refs\/heads\//, "")
    || event?.repository?.default_branch
    || "main";
}

/**
 * Decide whether the triage result must enqueue the planning workflow.
 *
 * @param {IssueTriagePlan} plan Safe triage plan.
 * @returns {boolean} True when planning must run before Codex.
 */
export function shouldDispatchIssuePlanning(plan) {
  return plan.route === ROUTE_DISCUSSION_BEFORE_PR;
}

/**
 * Build the GitHub Actions workflow_dispatch request for issue planning.
 *
 * Keeping this request construction pure gives the automation a stable,
 * testable contract: triage posts its canonical issue comment, then sends this
 * exact API request when the issue still needs the four-role planning lane.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber GitHub issue number.
 * @param {string} ref Git ref to run the planning workflow on.
 * @returns {{ url: string, init: RequestInit }} Fetch request descriptor.
 */
export function buildIssuePlanningDispatchRequest(repoFullName, issueNumber, ref) {
  const trimmedRef = typeof ref === "string" ? ref.trim() : "";

  if (typeof repoFullName !== "string" || !/^[^/]+\/[^/]+$/.test(repoFullName)) {
    throw new Error(`Invalid repository for planning dispatch: ${String(repoFullName)}`);
  }

  if (!trimmedRef) {
    throw new Error("Invalid ref for planning dispatch.");
  }

  return {
    url: `https://api.github.com/repos/${repoFullName}/actions/workflows/${ISSUE_PLANNING_WORKFLOW_FILE}/dispatches`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: trimmedRef,
        inputs: buildIssuePlanningDispatchInputs(issueNumber),
      }),
    },
  };
}

/**
 * Trigger the issue planning workflow through the GitHub Actions API.
 *
 * This is the reliable bridge from issue triage to API-owned planning. The
 * workflow token needs `actions: write`, configured in the triage workflow.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber GitHub issue number.
 * @param {string} ref Git ref to run the planning workflow on.
 * @returns {Promise<void>} Resolves when GitHub accepts the dispatch.
 */
async function dispatchIssuePlanningWorkflow(repoFullName, issueNumber, ref) {
  const request = buildIssuePlanningDispatchRequest(repoFullName, issueNumber, ref);

  await githubRequest(request.url, request.init);
}

/**
 * Write a compact GitHub Actions summary when the runner exposes it.
 *
 * @param {IssueTriagePlan} plan Safe triage plan.
 * @returns {Promise<void>} Resolves when summary is written or skipped.
 */
async function writeStepSummary(plan) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryPath) {
    return;
  }

  const body = [
    "## AI Issue Triage",
    "",
    `Impacto: ${plan.impact}`,
    `Fluxo: ${plan.route}`,
    `Ready for Codex: ${plan.route === ROUTE_DIRECT_PR}`,
    "",
    plan.decision,
    "",
    ...plan.nextSteps.map((step) => `- ${step}`),
    "",
  ].join("\n");

  await fs.appendFile(summaryPath, body, "utf8");
}

/**
 * Runtime dependencies used by the issue triage orchestrator.
 *
 * The production entrypoint uses the real implementations. Tests can inject
 * narrow fakes to exercise the release-critical handoff without touching the
 * filesystem, OpenAI, or GitHub.
 *
 * @typedef {object} IssueTriageRuntime
 * @property {(promptPath: string) => Promise<string>} readTriagePrompt Read the system prompt.
 * @property {(repoFullName: string, issueNumber: number) => Promise<any[]>} fetchIssueComments Fetch issue comments.
 * @property {(systemPrompt: string, userPrompt: string, model: string) => Promise<string>} generateIssueTriage Call the model.
 * @property {(repoFullName: string, issueNumber: number, currentBody: string | null | undefined, managedSection: string) => Promise<void>} updateIssueBodyAutomationSection Update the issue body.
 * @property {(repoFullName: string, issueNumber: number, body: string) => Promise<void>} upsertIssueComment Publish the sticky issue comment.
 * @property {(repoFullName: string, issueNumber: number, ref: string) => Promise<void>} dispatchIssuePlanningWorkflow Dispatch planning workflow.
 * @property {(plan: IssueTriagePlan) => Promise<void>} writeStepSummary Write Actions summary.
 */

/**
 * Default production runtime for issue triage.
 *
 * @type {IssueTriageRuntime}
 */
const ISSUE_TRIAGE_RUNTIME = {
  readTriagePrompt,
  fetchIssueComments,
  generateIssueTriage,
  updateIssueBodyAutomationSection,
  upsertIssueComment,
  dispatchIssuePlanningWorkflow,
  writeStepSummary,
};

/**
 * Execute the issue triage orchestration for one open GitHub issue.
 *
 * This is the testable core behind `main()`: it reads current context, asks the
 * model for a canonical route, posts the sticky comment, and only then dispatches
 * issue planning when the route is `discussion_before_pr`. Dispatch failures are
 * intentionally not swallowed because a posted comment without a planning run is
 * an incomplete handoff and must keep the workflow red.
 *
 * @param {object} input Orchestration input.
 * @param {string} input.repository Repository in owner/name form.
 * @param {any} input.issue GitHub issue payload.
 * @param {any} input.event Raw GitHub event payload.
 * @param {string} input.promptPath Prompt file path.
 * @param {string} input.model OpenAI model name.
 * @param {IssueTriageRuntime} [runtime] Runtime dependency overrides.
 * @returns {Promise<IssueTriagePlan | null>} Final plan, or null when skipped.
 */
export async function runIssueTriageWorkflow(input, runtime = ISSUE_TRIAGE_RUNTIME) {
  const { repository, issue, event, promptPath, model } = input;
  const workflowRef = resolveIssuePlanningDispatchRef(event);

  if (!issue) {
    throw new Error("This workflow only supports issue events.");
  }

  if (issue.pull_request) {
    console.log("Skipping issue triage because this issue event belongs to a pull request.");
    return null;
  }

  if (issue.state !== "open") {
    console.log("Skipping issue triage because the issue is not open.");
    return null;
  }

  if (!repository.includes("/")) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  const [systemPrompt, comments] = await Promise.all([
    runtime.readTriagePrompt(promptPath),
    runtime.fetchIssueComments(repository, issue.number),
  ]);
  const existingComment = findExistingTriageComment(comments);
  const humanIssueBody = stripIssueAutomationSection(issue.body ?? "");
  const userPrompt = [
    `Repository: ${repository}`,
    `Issue: #${issue.number} - ${issue.title}`,
    `State: ${issue.state}`,
    `Author: ${issue.user?.login ?? "[unknown]"}`,
    "",
    "## Issue body",
    truncateText(humanIssueBody, MAX_ISSUE_BODY_CHARS) || "[no description provided]",
    "",
    "## Existing sticky triage comment",
    truncateText(existingComment?.body ?? "", MAX_EXISTING_COMMENT_CHARS) || "[none]",
  ].join("\n");

  const rawTriage = await runtime.generateIssueTriage(systemPrompt, userPrompt, model);
  const plan = assertValidIssueTriagePlan(parseIssueTriageResponse(rawTriage));

  await runtime.updateIssueBodyAutomationSection(
    repository,
    issue.number,
    issue.body ?? "",
    buildIssueAutomationSection(plan, model),
  );

  const commentBody = buildIssueCommentBody(plan, model);
  await runtime.upsertIssueComment(repository, issue.number, commentBody);

  if (shouldDispatchIssuePlanning(plan)) {
    await runtime.dispatchIssuePlanningWorkflow(repository, issue.number, workflowRef);
  }

  await runtime.writeStepSummary(plan);

  return plan;
}

/**
 * Main workflow entrypoint.
 *
 * @returns {Promise<void>} Resolves when the issue comment is updated.
 */
async function main() {
  const eventPath = readRequiredEnv("GITHUB_EVENT_PATH");
  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const promptPath = process.env.AI_ISSUE_TRIAGE_PROMPT_PATH?.trim() || ".github/prompts/ai-issue-triage.md";
  const model = readConfiguredModel();
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const issue = event.issue;

  await runIssueTriageWorkflow({ repository, issue, event, promptPath, model });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
