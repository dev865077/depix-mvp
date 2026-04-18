/**
 * Automated issue triage runner.
 *
 * This workflow-side script reads one GitHub issue, asks OpenAI for a
 * structured triage decision, optionally creates a GitHub Discussion, and
 * keeps a single sticky comment on the issue with the current decision.
 */
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TRIAGE_MARKER = "<!-- ai-issue-triage:openai -->";
const IMPACT_LEVELS = new Set(["baixo", "medio", "alto"]);
const ROUTE_DIRECT_PR = "direct_pr";
const ROUTE_DISCUSSION_BEFORE_PR = "discussion_before_pr";
const ROUTES = new Set([ROUTE_DIRECT_PR, ROUTE_DISCUSSION_BEFORE_PR]);
const MAX_ISSUE_BODY_CHARS = 5000;
const MAX_EXISTING_COMMENT_CHARS = 5000;
const MAX_OUTPUT_TOKENS = 25000;
const REASONING_EFFORT = "low";
const DISCUSSION_ACKNOWLEDGEMENT_TITLE = "## Resposta operacional requerida";
const DISCUSSION_ACKNOWLEDGEMENT_BODY = [
  "Antes de abrir branch ou PR para esta issue, o implementador deve responder nesta Discussion com:",
  "- decisao operacional adotada",
  "- ordem de execucao",
  "- escopo da primeira PR",
  "- riscos ou pendencias que continuam fora da primeira PR",
].join("\n");

/**
 * @typedef {{
 *   summary: string,
 *   impact: "baixo" | "medio" | "alto",
 *   justification: string,
 *   route: "direct_pr" | "discussion_before_pr",
 *   productView: string,
 *   technicalView: string,
 *   riskView: string,
 *   decision: string,
 *   discussionTitle: string,
 *   nextSteps: string[],
 * }} IssueTriagePlan
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   isAnswerable: boolean,
 * }} DiscussionCategory
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

  return response.json();
}

/**
 * Perform an authenticated GitHub GraphQL request.
 *
 * @param {string} query GraphQL query or mutation text.
 * @param {Record<string, unknown>} [variables] GraphQL variables.
 * @returns {Promise<any>} Parsed GraphQL data.
 */
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
 * Fetch discussion metadata needed for category selection and deduplication.
 *
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @returns {Promise<{
 *   id: string,
 *   hasDiscussionsEnabled: boolean,
 *   discussionCategories: { nodes: DiscussionCategory[] },
 *   discussions: { nodes: Array<{ id: string, title: string, url: string }> },
 * }>} Repository discussion metadata.
 */
async function fetchRepositoryDiscussionMetadata(owner, name) {
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
        hasDiscussionsEnabled
        discussionCategories(first: 20) {
          nodes {
            id
            name
            isAnswerable
          }
        }
        discussions(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes {
            id
            title
            url
          }
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(query, { owner, name });
  const repository = data?.repository;

  if (!repository) {
    throw new Error("GitHub GraphQL response did not include repository metadata.");
  }

  if (repository.hasDiscussionsEnabled !== true) {
    throw new Error("GitHub Discussions is not enabled for this repository.");
  }

  return repository;
}

/**
 * Choose the safest discussion category for automated design debate.
 *
 * Selection order:
 * 1. explicitly configured category name
 * 2. `Ideas`
 * 3. `General`
 * 4. first non-answerable category
 * 5. first available category
 *
 * @param {DiscussionCategory[]} categories Repository discussion categories.
 * @param {string} [preferredName] Optional configured category name.
 * @returns {DiscussionCategory} Selected category.
 */
export function selectDiscussionCategory(categories, preferredName = "") {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("No GitHub Discussion categories are available in this repository.");
  }

  const normalizedPreferredName = preferredName.trim().toLowerCase();

  if (normalizedPreferredName) {
    const preferredCategory = categories.find((category) => category.name.toLowerCase() === normalizedPreferredName);

    if (preferredCategory) {
      return preferredCategory;
    }
  }

  const ideasCategory = categories.find((category) => category.name.toLowerCase() === "ideas");

  if (ideasCategory) {
    return ideasCategory;
  }

  const generalCategory = categories.find((category) => category.name.toLowerCase() === "general");

  if (generalCategory) {
    return generalCategory;
  }

  const firstOpenEndedCategory = categories.find((category) => category.isAnswerable !== true);

  if (firstOpenEndedCategory) {
    return firstOpenEndedCategory;
  }

  return categories[0];
}

/**
 * Extract a GitHub Discussion URL from a sticky triage comment body.
 *
 * @param {string} body Sticky comment body.
 * @returns {string | null} Discussion URL when present.
 */
export function extractDiscussionUrlFromComment(body) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }

  const markdownLinkMatch = body.match(/\[Discussion\]\((https:\/\/github\.com\/[^)\s]+\/discussions\/\d+)\)/i);

  if (markdownLinkMatch) {
    return markdownLinkMatch[1];
  }

  const plainUrlMatch = body.match(/https:\/\/github\.com\/[^\s)]+\/discussions\/\d+/i);

  return plainUrlMatch ? plainUrlMatch[0] : null;
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
 * Detect a pre-existing discussion to avoid duplicates across reruns.
 *
 * The sticky comment is the primary source of truth. Recent repository
 * discussions are a fallback in case the comment was removed or edited.
 *
 * @param {number} issueNumber Issue number.
 * @param {any[]} comments Issue comments.
 * @param {Array<{ title: string, url: string }>} discussions Recent discussions.
 * @returns {string | null} Existing discussion URL if found.
 */
function findExistingDiscussionUrl(issueNumber, comments, discussions) {
  const stickyComment = findExistingTriageComment(comments);
  const commentDiscussionUrl = stickyComment ? extractDiscussionUrlFromComment(stickyComment.body) : null;

  if (commentDiscussionUrl) {
    return commentDiscussionUrl;
  }

  const issueMarker = `[Issue #${issueNumber}]`;
  const matchingDiscussion = discussions.find((discussion) => typeof discussion.title === "string" && discussion.title.includes(issueMarker));

  return matchingDiscussion?.url ?? null;
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
  const textFields = {
    summary: rawPlan.summary,
    justification: rawPlan.justification,
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

  if (impact === "baixo" && route !== ROUTE_DIRECT_PR) {
    throw new Error("Low impact issues must route directly to PR.");
  }

  if ((impact === "medio" || impact === "alto") && route !== ROUTE_DISCUSSION_BEFORE_PR) {
    throw new Error("Medium/high impact issues must require Discussion before PR.");
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
    throw new Error("AI issue triage must provide discussionTitle for medium/high impact issues.");
  }

  return {
    summary: rawPlan.summary.trim(),
    impact,
    justification: rawPlan.justification.trim(),
    route,
    productView: rawPlan.productView.trim(),
    technicalView: rawPlan.technicalView.trim(),
    riskView: rawPlan.riskView.trim(),
    decision: rawPlan.decision.trim(),
    discussionTitle,
    nextSteps,
  };
}

/**
 * Create a new GitHub Discussion for the issue debate.
 *
 * @param {string} repositoryId Repository GraphQL node id.
 * @param {string} categoryId Selected discussion category id.
 * @param {string} title Discussion title.
 * @param {string} body Discussion body.
 * @returns {Promise<{ id: string, url: string }>} Created discussion metadata.
 */
async function createDiscussion(repositoryId, categoryId, title, body) {
  const mutation = `
    mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repositoryId,
        categoryId: $categoryId,
        title: $title,
        body: $body
      }) {
        discussion {
          id
          url
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(mutation, { repositoryId, categoryId, title, body });
  const discussion = data?.createDiscussion?.discussion;

  if (!discussion?.url) {
    throw new Error("GitHub GraphQL response did not include the created discussion URL.");
  }

  return discussion;
}

/**
 * Build the markdown body for the sticky issue comment.
 *
 * @param {IssueTriagePlan} plan Safe triage plan.
 * @param {string} model Explicit model name.
 * @param {string | null} discussionUrl Existing or newly created discussion URL.
 * @returns {string} Markdown comment body.
 */
export function buildIssueCommentBody(plan, model, discussionUrl) {
  const routeLabel = plan.route === ROUTE_DIRECT_PR ? "PR direta" : "Discussion antes da PR";
  const discussionSection = discussionUrl
    ? [
      "## Discussion",
      "",
      `[Discussion](${discussionUrl})`,
      "",
      DISCUSSION_ACKNOWLEDGEMENT_TITLE,
      DISCUSSION_ACKNOWLEDGEMENT_BODY,
    ]
    : [];

  return [
    TRIAGE_MARKER,
    "## AI Issue Triage",
    "",
    `Model: \`${model}\``,
    `Impacto: \`${plan.impact}\``,
    `Fluxo recomendado: \`${routeLabel}\``,
    "",
    "## Justificativa",
    plan.justification,
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
    ...(discussionSection.length > 0 ? ["", ...discussionSection] : []),
  ].join("\n");
}

/**
 * Build the markdown body for a newly created Discussion.
 *
 * @param {{
 *   number: number,
 *   title: string,
 *   url: string,
 *   body?: string | null,
 * }} issue Issue payload from GitHub.
 * @param {IssueTriagePlan} plan Safe triage plan.
 * @returns {string} Markdown body.
 */
export function buildDiscussionBody(issue, plan) {
  return [
    `Issue origem: #${issue.number} - [${issue.title}](${issue.url})`,
    "",
    "## Contexto da issue",
    truncateText(issue.body ?? "[sem descricao]", MAX_ISSUE_BODY_CHARS),
    "",
    "## Classificacao",
    `- Impacto: \`${plan.impact}\``,
    `- Fluxo: \`${plan.route}\``,
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
    "## Sintese final",
    plan.decision,
    "",
    DISCUSSION_ACKNOWLEDGEMENT_TITLE,
    DISCUSSION_ACKNOWLEDGEMENT_BODY,
    "",
    "## Proximos passos",
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
 * Write a compact GitHub Actions summary when the runner exposes it.
 *
 * @param {IssueTriagePlan} plan Safe triage plan.
 * @param {string | null} discussionUrl Existing or newly created discussion URL.
 * @returns {Promise<void>} Resolves when summary is written or skipped.
 */
async function writeStepSummary(plan, discussionUrl) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryPath) {
    return;
  }

  const body = [
    "## AI Issue Triage",
    "",
    `Impacto: ${plan.impact}`,
    `Fluxo: ${plan.route}`,
    "",
    plan.decision,
    "",
    ...plan.nextSteps.map((step) => `- ${step}`),
    ...(discussionUrl ? ["", `Discussion: ${discussionUrl}`] : []),
    "",
  ].join("\n");

  await fs.appendFile(summaryPath, body, "utf8");
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
  const preferredDiscussionCategory = process.env.AI_ISSUE_TRIAGE_DISCUSSION_CATEGORY?.trim() || "Ideas";
  const model = readConfiguredModel();
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const issue = event.issue;

  if (!issue) {
    throw new Error("This workflow only supports issue events.");
  }

  if (issue.pull_request) {
    console.log("Skipping issue triage because this issue event belongs to a pull request.");
    return;
  }

  if (issue.state !== "open") {
    console.log("Skipping issue triage because the issue is not open.");
    return;
  }

  const [owner, name] = repository.split("/");

  if (!owner || !name) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  const [systemPrompt, comments] = await Promise.all([
    readTriagePrompt(promptPath),
    fetchIssueComments(repository, issue.number),
  ]);
  const existingComment = findExistingTriageComment(comments);
  const userPrompt = [
    `Repository: ${repository}`,
    `Issue: #${issue.number} - ${issue.title}`,
    `State: ${issue.state}`,
    `Author: ${issue.user?.login ?? "[unknown]"}`,
    "",
    "## Issue body",
    truncateText(issue.body ?? "", MAX_ISSUE_BODY_CHARS) || "[no description provided]",
    "",
    "## Existing sticky triage comment",
    truncateText(existingComment?.body ?? "", MAX_EXISTING_COMMENT_CHARS) || "[none]",
  ].join("\n");

  const rawTriage = await generateIssueTriage(systemPrompt, userPrompt, model);
  const plan = assertValidIssueTriagePlan(parseIssueTriageResponse(rawTriage));
  let discussionUrl = null;

  if (plan.route === ROUTE_DISCUSSION_BEFORE_PR) {
    const repositoryMetadata = await fetchRepositoryDiscussionMetadata(owner, name);
    discussionUrl = findExistingDiscussionUrl(issue.number, comments, repositoryMetadata.discussions.nodes);

    if (!discussionUrl) {
      const category = selectDiscussionCategory(repositoryMetadata.discussionCategories.nodes, preferredDiscussionCategory);
      const discussionTitle = `[Issue #${issue.number}] ${plan.discussionTitle}`;
      const discussionBody = buildDiscussionBody(issue, plan);
      const discussion = await createDiscussion(repositoryMetadata.id, category.id, discussionTitle, discussionBody);

      discussionUrl = discussion.url;
    }
  }

  const commentBody = buildIssueCommentBody(plan, model, discussionUrl);
  await upsertIssueComment(repository, issue.number, commentBody);
  await writeStepSummary(plan, discussionUrl);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
