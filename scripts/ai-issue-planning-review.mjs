/**
 * Automated issue planning review runner.
 *
 * This workflow reviews issue and epic quality inside the GitHub Discussion
 * opened by the triage lane. It is append-only by design:
 * - one top-level comment per specialist reviewer role
 * - one final status comment with unanimous gate outcome
 */
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Stable markers that make automated planning comments easy to identify.
 *
 * The workflow is append-only, so these markers let later tooling locate the
 * current automated review trail without mutating historical comments.
 */
const DISCUSSION_COMMENT_MARKER = "<!-- ai-issue-planning-review:openai -->";
const DISCUSSION_FINAL_COMMENT_MARKER = "<!-- ai-issue-planning-final:openai -->";
const ISSUE_TITLE_PREFIX = "[Issue #";

/**
 * Prompt-budget limits for issue and Discussion context.
 *
 * The goal is to keep enough history for useful planning review while still
 * bounding cost, latency, and model drift caused by oversized prompts.
 */
const MAX_ISSUE_BODY_CHARS = 7000;
const MAX_DISCUSSION_CONTEXT_COMMENTS = 24;
const MAX_DISCUSSION_CONTEXT_CHARS = 18000;
const MAX_DISCUSSION_CONTEXT_COMMENT_CHARS = 1600;
const MAX_ISSUE_COMMENT_CHARS = 2000;
const MAX_CHILD_ISSUE_BODY_CHARS = 1600;
const MAX_CHILD_ISSUES = 24;
const MAX_OUTPUT_TOKENS = 2200;
const OPENAI_REQUEST_TIMEOUT_MS = 120000;
const REASONING_EFFORT = "low";

/**
 * The planning gate is intentionally binary.
 *
 * A backlog slice is either ready to implement or still blocked by at least
 * one reviewer role. This avoids ambiguous intermediate states.
 */
const ALLOWED_RECOMMENDATIONS = new Set(["Approve", "Request changes"]);

/**
 * Emit a stable JSON log line for GitHub Actions and later incident reading.
 *
 * @param {string} event Event name.
 * @param {Record<string, unknown>} [fields] Structured operational fields.
 * @returns {void}
 */
function logOperationalEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * Read one required environment variable and fail closed when it is blank.
 *
 * @param {string} key Variable name.
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
 * Resolve the model configured for issue planning review.
 *
 * The dedicated variable takes precedence, but the repository can still reuse
 * the PR review model when it wants one shared default.
 *
 * @returns {string} Explicit model name.
 */
function readConfiguredModel() {
  const model =
    process.env.OPENAI_ISSUE_PLANNING_REVIEW_MODEL?.trim() ||
    process.env.OPENAI_PR_REVIEW_MODEL?.trim();

  if (!model) {
    throw new Error("Missing required environment variable: OPENAI_ISSUE_PLANNING_REVIEW_MODEL or OPENAI_PR_REVIEW_MODEL.");
  }

  if (/\s/.test(model)) {
    throw new Error("Invalid issue planning review model name: model name cannot contain whitespace.");
  }

  logOperationalEvent("ai_issue_planning_review.model", { model });
  return model;
}

/**
 * Truncate text for safe prompt assembly.
 *
 * @param {string | null | undefined} value Raw text value.
 * @param {number} maxLength Maximum allowed length.
 * @returns {string} Bounded text.
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
 * Read one repository-owned prompt file.
 *
 * @param {string} promptPath Relative path to the prompt file.
 * @returns {Promise<string>} Prompt contents.
 */
async function readPrompt(promptPath) {
  try {
    return await fs.readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read AI issue planning prompt file at ${promptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Perform one authenticated GitHub REST API request.
 *
 * @param {string} url Full GitHub API URL.
 * @param {RequestInit} [init] Extra fetch options.
 * @returns {Promise<any>} Parsed JSON payload.
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
 * Perform one authenticated GitHub GraphQL request.
 *
 * @param {string} query GraphQL query or mutation.
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
 * Fetch stable issue comments through the REST API.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber Issue number.
 * @returns {Promise<any[]>} Issue comments.
 */
async function fetchIssueComments(repoFullName, issueNumber) {
  return githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments?per_page=100`);
}

/**
 * Fetch one issue by number.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber Issue number.
 * @returns {Promise<any>} Issue payload.
 */
async function fetchIssue(repoFullName, issueNumber) {
  return githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}`);
}

/**
 * Fetch one linked Discussion with top-level comments and replies.
 *
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @param {number} discussionNumber Discussion number.
 * @returns {Promise<any>} Discussion payload.
 */
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
              replies(first: 20) {
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

/**
 * Fetch recent Discussions for fallback issue-to-discussion association.
 *
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @returns {Promise<Array<{ number: number, title: string, url: string }>>} Recent discussions.
 */
async function fetchRecentDiscussions(owner, name) {
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        discussions(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes {
            number
            title
            url
          }
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(query, { owner, name });

  return data?.repository?.discussions?.nodes ?? [];
}

/**
 * Concatenate the shared doctrine with one role-specific prompt.
 *
 * @param {string} doctrine Shared doctrine.
 * @param {string} rolePrompt Role-specific prompt.
 * @returns {string} Final system prompt.
 */
function composeSystemPrompt(doctrine, rolePrompt) {
  return [doctrine.trim(), "", "---", "", rolePrompt.trim()].join("\n");
}

/**
 * Extract text from one OpenAI Responses content item.
 *
 * @param {any} contentItem One content item from the Responses payload.
 * @returns {string} Extracted text or empty string.
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
 * Summarize one OpenAI Responses envelope for diagnostics.
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
 * Extract plain text from one OpenAI Responses payload.
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
 * Ask OpenAI for one role memo in Markdown form.
 *
 * @param {string} systemPrompt Final system prompt.
 * @param {string} userPrompt Shared user payload.
 * @param {string} model Explicit model name.
 * @returns {Promise<string>} Markdown memo.
 */
async function generateModelMarkdown(systemPrompt, userPrompt, model) {
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
    throw new Error(`OpenAI request failed for model ${model} (${response.status}): ${body}`);
  }

  const responseJson = await response.json();
  const reviewText = readOpenAIText(responseJson);

  if (!reviewText) {
    throw new Error(`OpenAI returned an empty issue planning memo. Response summary: ${summarizeOpenAIResponse(responseJson)}`);
  }

  return reviewText.trim();
}

/**
 * Remove superficial markdown formatting from a recommendation candidate.
 *
 * @param {string} value Raw candidate text.
 * @returns {string} Reduced value.
 */
function cleanRecommendationCandidate(value) {
  return value
    .replace(/^[\s>*`#-]+/, "")
    .replace(/[*`]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .replace(/\s*:+\s*$/, "")
    .trim();
}

/**
 * Normalize a candidate recommendation to the allowed set.
 *
 * @param {string} value Candidate text.
 * @returns {string | null} Allowed recommendation or null.
 */
function normalizeRecommendationCandidate(value) {
  const cleanedValue = cleanRecommendationCandidate(value).toLowerCase();

  if (cleanedValue === "approve") {
    return "Approve";
  }

  if (cleanedValue === "request changes" || cleanedValue === "request change") {
    return "Request changes";
  }

  return null;
}

/**
 * Extract the final recommendation from a markdown memo.
 *
 * @param {string} reviewText Markdown text.
 * @returns {string | null} Recommendation when found.
 */
export function extractPlanningRecommendation(reviewText) {
  const headingInlineMatch = reviewText.match(/^\s*#{1,6}\s*Recommendation\s*:?\s*(Approve|Request changes)\s*$/im);

  if (headingInlineMatch) {
    return normalizeRecommendationCandidate(headingInlineMatch[1]);
  }

  const headingBlockMatch = reviewText.match(/^\s*#{1,6}\s*Recommendation\s*:?\s*$/im);

  if (headingBlockMatch) {
    const trailingText = reviewText.slice(headingBlockMatch.index + headingBlockMatch[0].length);
    const candidateLine = trailingText.split(/\r?\n/).find((line) => line.trim().length > 0);
    const normalizedCandidate = candidateLine ? normalizeRecommendationCandidate(candidateLine) : null;

    if (normalizedCandidate) {
      return normalizedCandidate;
    }
  }

  return null;
}

/**
 * Validate that one specialist memo uses the canonical recommendation contract.
 *
 * @param {string} role Role name for diagnostics.
 * @param {string} reviewText Markdown review text.
 * @returns {string} Valid recommendation.
 */
function assertValidPlanningRecommendation(role, reviewText) {
  const recommendation = extractPlanningRecommendation(reviewText);

  if (!recommendation || !ALLOWED_RECOMMENDATIONS.has(recommendation)) {
    throw new Error(`${role} issue-planning memo is missing the ## Recommendation section with Approve or Request changes.`);
  }

  return recommendation;
}

/**
 * Build a bounded fallback memo when one reviewer role fails.
 *
 * @param {string} role Reviewer role name.
 * @param {unknown} error Error thrown by the model request.
 * @returns {string} Safe fallback memo.
 */
export function buildModelFailureMemo(role, error) {
  const message = error instanceof Error ? error.message : String(error);

  return [
    "## Perspective",
    `The ${role} reviewer could not complete within the automation budget.`,
    "",
    "## Findings",
    "- Automated review role failed before producing a memo.",
    `- Failure: \`${truncateText(message, 220).replace(/`/g, "'")}\``,
    "",
    "## Questions",
    "- None.",
    "",
    "## Backlog posture",
    "Request changes until the planning review can be rerun or manually accepted by a maintainer.",
    "",
    "## Recommendation",
    "Request changes",
  ].join("\n");
}

/**
 * Parse one issue number from text such as `[Issue #91]` or `Issue origem: #91`.
 *
 * @param {string} text Arbitrary text.
 * @returns {number | null} Parsed issue number.
 */
export function extractIssueNumberFromText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  const bracketMatch = text.match(/\[Issue\s+#(\d+)\]/i);

  if (bracketMatch) {
    return Number.parseInt(bracketMatch[1], 10);
  }

  const originMatch = text.match(/Issue origem:\s*#(\d+)/i);

  return originMatch ? Number.parseInt(originMatch[1], 10) : null;
}

/**
 * Extract the linked root issue number from a Discussion payload.
 *
 * @param {{ title?: string | null, body?: string | null }} discussion Discussion payload.
 * @returns {number | null} Parsed issue number.
 */
export function extractIssueNumberFromDiscussion(discussion) {
  return extractIssueNumberFromText(discussion.title ?? "") ?? extractIssueNumberFromText(discussion.body ?? "");
}

/**
 * Parse referenced issue numbers from the root issue body.
 *
 * @param {string | null | undefined} body Root issue body.
 * @param {number} rootIssueNumber Current issue number.
 * @returns {number[]} Unique referenced issue numbers.
 */
export function parseReferencedIssueNumbers(body, rootIssueNumber) {
  if (typeof body !== "string" || body.length === 0) {
    return [];
  }

  const matches = body.match(/#\d+/g) ?? [];
  const uniqueIssueNumbers = new Set();

  for (const match of matches) {
    const issueNumber = Number.parseInt(match.slice(1), 10);

    if (Number.isInteger(issueNumber) && issueNumber > 0 && issueNumber !== rootIssueNumber) {
      uniqueIssueNumbers.add(issueNumber);
    }
  }

  return [...uniqueIssueNumbers].sort((left, right) => left - right).slice(0, MAX_CHILD_ISSUES);
}

/**
 * Build a compact issue comment history for the planning prompt.
 *
 * @param {any[]} comments Issue comments.
 * @returns {string} Bounded comment history.
 */
function buildIssueCommentContext(comments) {
  const selectedComments = comments
    .slice(-8)
    .map((comment) => [
      `### ${comment.user?.login ?? "unknown"} @ ${comment.created_at ?? "unknown"}`,
      truncateText(comment.body ?? "[empty]", MAX_ISSUE_COMMENT_CHARS),
    ].join("\n"));

  return selectedComments.join("\n\n");
}

/**
 * Build bounded Discussion history from top-level comments and replies.
 *
 * @param {any} discussion Discussion GraphQL payload.
 * @returns {string} Compact discussion history.
 */
export function buildDiscussionHistoryContext(discussion) {
  const entries = [];

  for (const comment of discussion.comments?.nodes ?? []) {
    if (!isAutomatedPlanningComment(comment)) {
      entries.push([
        `### ${comment.author?.login ?? "unknown"} @ ${comment.createdAt ?? "unknown"}`,
        truncateText(comment.body ?? "[empty]", MAX_DISCUSSION_CONTEXT_COMMENT_CHARS),
      ].join("\n"));
    }

    for (const reply of comment.replies?.nodes ?? []) {
      entries.push([
        `#### reply by ${reply.author?.login ?? "unknown"} @ ${reply.createdAt ?? "unknown"}`,
        truncateText(reply.body ?? "[empty]", MAX_DISCUSSION_CONTEXT_COMMENT_CHARS),
      ].join("\n"));
    }
  }

  return truncateText(entries.slice(-MAX_DISCUSSION_CONTEXT_COMMENTS).join("\n\n"), MAX_DISCUSSION_CONTEXT_CHARS);
}

/**
 * Detecta comentarios automatizados do proprio planning review.
 *
 * A Discussion e append-only por desenho, entao rodadas antigas podem conter
 * `Request changes` que ja foram resolvidos por edicao da issue e replies
 * humanas. Esses blocos nao devem entrar como "estado atual" no prompt de uma
 * nova rodada; caso contrario, o modelo tende a reprovar lendo um status velho
 * como se fosse o resultado vigente. As replies humanas continuam preservadas
 * em `buildDiscussionHistoryContext()` porque carregam a decisao operacional
 * que resolveu cada ponto.
 *
 * @param {string | null | undefined} body Corpo bruto do comentario.
 * @returns {boolean} Verdadeiro quando o comentario e output automatizado antigo.
 */
export function isAutomatedPlanningCommentBody(body) {
  if (typeof body !== "string") {
    return false;
  }

  const trimmedBody = body.trimStart();

  return trimmedBody.startsWith(DISCUSSION_COMMENT_MARKER)
    || trimmedBody.startsWith(DISCUSSION_FINAL_COMMENT_MARKER);
}

/**
 * Detecta se um comentario da Discussion e output automatizado antigo.
 *
 * A decisao usa corpo e autor. Isso evita remover contexto humano quando uma
 * pessoa cola o marcador dentro de uma explicacao operacional ou bug report.
 *
 * @param {{ author?: { login?: string | null } | null, body?: string | null }} comment Comentario GraphQL.
 * @returns {boolean} Verdadeiro apenas para comentarios do bot com marcador canonico.
 */
export function isAutomatedPlanningComment(comment) {
  const authorLogin = comment?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && isAutomatedPlanningCommentBody(comment?.body);
}

/**
 * Build the shared user payload for every planning reviewer role.
 *
 * @param {string} repository Repository in owner/name form.
 * @param {any} issue Root issue payload.
 * @param {any[]} childIssues Referenced issue payloads.
 * @param {any[]} issueComments Issue comments.
 * @param {string} discussionContext Prior Discussion context.
 * @returns {string} Final user payload.
 */
export function buildIssuePlanningUserPrompt(repository, issue, childIssues, issueComments, discussionContext) {
  const childIssueSections = childIssues.length > 0
    ? childIssues.map((childIssue) => [
      `### #${childIssue.number} - ${childIssue.title}`,
      `- state: ${String(childIssue.state ?? "unknown").toLowerCase()}`,
      `- labels: ${(childIssue.labels ?? []).map((label) => label.name).join(", ") || "(none)"}`,
      "",
      truncateText(childIssue.body ?? "[no description provided]", MAX_CHILD_ISSUE_BODY_CHARS),
    ].join("\n"))
    : ["[no referenced child issues found in the root issue body]"];

  return [
    `Repository: ${repository}`,
    `Root issue: #${issue.number} - ${issue.title}`,
    `State: ${issue.state}`,
    `URL: ${issue.html_url ?? issue.url ?? "[unknown]"}`,
    "",
    "## Root issue body",
    truncateText(issue.body ?? "", MAX_ISSUE_BODY_CHARS) || "[no description provided]",
    "",
    "## Referenced child or dependency issues",
    ...childIssueSections,
    "",
    "## Issue comments",
    buildIssueCommentContext(issueComments) || "[no issue comments]",
    "",
    "## Discussion context",
    discussionContext || "[no prior discussion comments]",
  ].join("\n");
}

/**
 * Evaluate the unanimous planning gate across the four specialist roles.
 *
 * @param {{ product: string, technical: string, scrum: string, risk: string }} debate Debate output.
 * @returns {{
 *   recommendation: "Approve" | "Request changes",
 *   recommendations: Record<string, string>,
 *   blockingRoles: string[]
 * }} Planning verdict.
 */
export function evaluateIssuePlanningRecommendation(debate) {
  const recommendations = {
    product: assertValidPlanningRecommendation("Product", debate.product),
    technical: assertValidPlanningRecommendation("Technical", debate.technical),
    scrum: assertValidPlanningRecommendation("Scrum", debate.scrum),
    risk: assertValidPlanningRecommendation("Risk", debate.risk),
  };
  const blockingRoles = Object.entries(recommendations)
    .filter(([, recommendation]) => recommendation !== "Approve")
    .map(([role]) => role);

  return {
    recommendation: blockingRoles.length === 0 ? "Approve" : "Request changes",
    recommendations,
    blockingRoles,
  };
}

/**
 * Build append-only Discussion comments for the four specialist reviewers.
 *
 * @param {{ product: string, technical: string, scrum: string, risk: string }} debate Debate output.
 * @returns {Array<{ key: string, role: string, body: string }>} Comment payloads.
 */
export function buildIssuePlanningReviewComments(debate) {
  return [
    {
      key: "product",
      role: "Product and scope",
      body: [
        DISCUSSION_COMMENT_MARKER,
        "<!-- ai-issue-planning-role:product -->",
        "## Product and scope review",
        "",
        debate.product,
      ].join("\n"),
    },
    {
      key: "technical",
      role: "Technical and architecture",
      body: [
        DISCUSSION_COMMENT_MARKER,
        "<!-- ai-issue-planning-role:technical -->",
        "## Technical and architecture review",
        "",
        debate.technical,
      ].join("\n"),
    },
    {
      key: "scrum",
      role: "Delivery and Scrum planning",
      body: [
        DISCUSSION_COMMENT_MARKER,
        "<!-- ai-issue-planning-role:scrum -->",
        "## Delivery and Scrum planning review",
        "",
        debate.scrum,
      ].join("\n"),
    },
    {
      key: "risk",
      role: "Risk, quality, and operations",
      body: [
        DISCUSSION_COMMENT_MARKER,
        "<!-- ai-issue-planning-role:risk -->",
        "## Risk, quality, and operations review",
        "",
        debate.risk,
      ].join("\n"),
    },
  ];
}

/**
 * Build the final visible lifecycle comment for the planning Discussion.
 *
 * @param {"Approve" | "Request changes"} recommendation Final recommendation.
 * @param {string[]} [blockingRoles] Specialist roles still blocking.
 * @returns {string} Final status comment.
 */
export function buildIssuePlanningCompletionComment(recommendation, blockingRoles = []) {
  const isApproved = recommendation === "Approve";
  const statusLine = isApproved
    ? "Planning review concluded: all four specialist reviewer roles returned `Approve`."
    : "Planning review concluded: unanimous approval was not reached across the specialist reviewer roles.";
  const closeLine = isApproved
    ? "This append-only comment is the visible readiness marker before implementation starts."
    : "The planning Discussion remains open because at least one specialist reviewer role still requests changes.";
  const blockerLine = !isApproved && blockingRoles.length > 0
    ? `Blocking roles: ${blockingRoles.map((role) => `\`${role}\``).join(", ")}`
    : null;
  const policyLine =
    "Execution readiness requires unanimous `Approve` from `product`, `technical`, `scrum`, and `risk`.";
  const canonicalLine =
    "Because this workflow is append-only, this newest final-status comment supersedes earlier automated final-status comments in this Discussion.";

  return [
    DISCUSSION_FINAL_COMMENT_MARKER,
    "## Planning status",
    "",
    statusLine,
    closeLine,
    ...(blockerLine ? [blockerLine] : []),
    policyLine,
    canonicalLine,
    "",
    `Final recommendation: \`${recommendation}\``,
  ].join("\n");
}

/**
 * Publish one append-only discussion comment.
 *
 * @param {string} discussionId Discussion node id.
 * @param {string} body Markdown body.
 * @returns {Promise<void>} Completes when the comment is persisted.
 */
async function createDiscussionComment(discussionId, body) {
  const mutation = `
    mutation($discussionId: ID!, $body: String!) {
      addDiscussionComment(input: {
        discussionId: $discussionId,
        body: $body
      }) {
        comment {
          id
          url
        }
      }
    }
  `;
  await githubGraphqlRequest(mutation, { discussionId, body });
}

/**
 * Extract a linked Discussion URL from the sticky triage comment set.
 *
 * @param {any[]} comments Issue comments.
 * @returns {string | null} Discussion URL when found.
 */
function extractDiscussionUrlFromComments(comments) {
  for (const comment of comments) {
    const body = typeof comment.body === "string" ? comment.body : "";
    const markdownLinkMatch = body.match(/\[Discussion\]\((https:\/\/github\.com\/[^)\s]+\/discussions\/\d+)\)/i);

    if (markdownLinkMatch) {
      return markdownLinkMatch[1];
    }
  }

  return null;
}

/**
 * Parse the numeric Discussion identifier from a GitHub URL.
 *
 * @param {string} url Discussion URL.
 * @returns {number | null} Discussion number.
 */
function extractDiscussionNumberFromUrl(url) {
  const match = typeof url === "string" ? url.match(/\/discussions\/(\d+)/i) : null;

  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Detect whether the current event comment came from the automation bot.
 *
 * This guard prevents append-only comments published by the workflow from
 * recursively triggering another planning round.
 *
 * @param {any} event Raw GitHub event payload.
 * @returns {boolean} True when the triggering comment belongs to the bot.
 */
export function isAutomationDiscussionCommentEvent(event) {
  if (!event?.comment || !event?.discussion) {
    return false;
  }

  const commentAuthor = event.comment.user?.login || event.comment.author?.login;
  return commentAuthor === "github-actions[bot]";
}

/**
 * Read manual rerun inputs from a `workflow_dispatch` event.
 *
 * Maintainers can use this path to backfill older issues/discussions or to
 * rerun the planning gate when the Discussion thread already exists but no new
 * discussion activity would naturally trigger the workflow.
 *
 * @param {any} event Raw GitHub event payload.
 * @returns {{ issueNumber: number | null, discussionNumber: number | null }} Parsed manual target.
 */
export function parseManualPlanningTarget(event) {
  const issueCandidate = event?.inputs?.issue_number;
  const discussionCandidate = event?.inputs?.discussion_number;
  const issueNumber = typeof issueCandidate === "string" && /^\d+$/.test(issueCandidate)
    ? Number.parseInt(issueCandidate, 10)
    : null;
  const discussionNumber = typeof discussionCandidate === "string" && /^\d+$/.test(discussionCandidate)
    ? Number.parseInt(discussionCandidate, 10)
    : null;

  return { issueNumber, discussionNumber };
}

/**
 * Resolve the linked triage Discussion number for one issue.
 *
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @param {number} issueNumber Issue number.
 * @param {any[]} comments Current issue comments.
 * @returns {Promise<number | null>} Discussion number when found.
 */
async function findIssueDiscussionNumber(owner, name, issueNumber, comments) {
  const discussionUrl = extractDiscussionUrlFromComments(comments);

  if (discussionUrl) {
    return extractDiscussionNumberFromUrl(discussionUrl);
  }

  const discussions = await fetchRecentDiscussions(owner, name);
  const matchingDiscussion = discussions.find((discussion) =>
    typeof discussion.title === "string" && discussion.title.includes(`${ISSUE_TITLE_PREFIX}${issueNumber}]`));

  return matchingDiscussion?.number ?? null;
}

/**
 * Resolve issue and Discussion context from the current GitHub event.
 *
 * @param {any} event Raw GitHub event JSON.
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @param {string} repository Repository in owner/name form.
 * @returns {Promise<{ issue: any, discussion: any } | null>} Planning context or null when irrelevant.
 */
async function resolvePlanningContext(event, owner, name, repository) {
  const manualTarget = parseManualPlanningTarget(event);

  if (manualTarget.discussionNumber) {
    const discussion = await fetchDiscussionByNumber(owner, name, manualTarget.discussionNumber);
    const issueNumber = extractIssueNumberFromDiscussion(discussion);

    if (!issueNumber) {
      throw new Error(`Manual planning rerun for Discussion #${manualTarget.discussionNumber} could not resolve a linked issue.`);
    }

    const issue = await fetchIssue(repository, issueNumber);

    if (issue.state !== "open") {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "manual_discussion_linked_issue_not_open",
        issueNumber: issue.number,
        discussionNumber: discussion.number,
      });
      return null;
    }

    return { issue, discussion };
  }

  if (manualTarget.issueNumber) {
    const issue = await fetchIssue(repository, manualTarget.issueNumber);

    if (issue.state !== "open") {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "manual_issue_not_open",
        issueNumber: issue.number,
      });
      return null;
    }

    const issueComments = await fetchIssueComments(repository, issue.number);
    const discussionNumber = await findIssueDiscussionNumber(owner, name, issue.number, issueComments);

    if (!discussionNumber) {
      throw new Error(`Manual planning rerun for issue #${issue.number} could not find a linked Discussion.`);
    }

    const discussion = await fetchDiscussionByNumber(owner, name, discussionNumber);
    return { issue, discussion };
  }

  // Issue-triggered runs first try to locate the triage Discussion that owns
  // planning for this issue. If triage has not opened it yet, the workflow
  // exits quietly and waits for the Discussion-side trigger.
  if (event.issue && !event.issue.pull_request) {
    if (event.issue.state !== "open") {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "issue_not_open",
        issueNumber: event.issue.number,
      });
      return null;
    }

    const issueComments = await fetchIssueComments(repository, event.issue.number);
    const discussionNumber = await findIssueDiscussionNumber(owner, name, event.issue.number, issueComments);

    if (!discussionNumber) {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "no_discussion_for_issue",
        issueNumber: event.issue.number,
      });
      return null;
    }

    const discussion = await fetchDiscussionByNumber(owner, name, discussionNumber);
    return { issue: event.issue, discussion };
  }

  if (event.comment && event.discussion) {
    // Ignore our own append-only comments so one automation write does not
    // recursively trigger another planning round.
    if (isAutomationDiscussionCommentEvent(event)) {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "bot_comment",
        discussionNumber: event.discussion.number,
      });
      return null;
    }
  }

  if (event.discussion) {
    // Discussion-triggered runs reload the canonical Discussion payload so the
    // debate always uses fresh comments, replies, and linked issue metadata.
    const discussion = await fetchDiscussionByNumber(owner, name, event.discussion.number);
    const issueNumber = extractIssueNumberFromDiscussion(discussion);

    if (!issueNumber) {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "discussion_not_linked_to_issue",
        discussionNumber: discussion.number,
      });
      return null;
    }

    const issue = await fetchIssue(repository, issueNumber);

    if (issue.state !== "open") {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "linked_issue_not_open",
        issueNumber: issue.number,
        discussionNumber: discussion.number,
      });
      return null;
    }

    return { issue, discussion };
  }

  throw new Error("Unsupported GitHub event for issue planning review.");
}

/**
 * Run the four-role debate and return one memo per specialist role.
 *
 * @param {{
 *   model: string,
 *   doctrine: string,
 *   productPrompt: string,
 *   technicalPrompt: string,
 *   scrumPrompt: string,
 *   riskPrompt: string,
 *   userPrompt: string,
 * }} input Debate inputs.
 * @returns {Promise<{ product: string, technical: string, scrum: string, risk: string }>} Debate output.
 */
async function runIssuePlanningDebate(input) {
  logOperationalEvent("ai_issue_planning_review.debate.start", {});

  // Every specialist sees the same user payload. Only the doctrine overlay is
  // different, which makes disagreements attributable to perspective rather
  // than to different input context.
  const roleResults = await Promise.allSettled([
    generateModelMarkdown(composeSystemPrompt(input.doctrine, input.productPrompt), input.userPrompt, input.model),
    generateModelMarkdown(composeSystemPrompt(input.doctrine, input.technicalPrompt), input.userPrompt, input.model),
    generateModelMarkdown(composeSystemPrompt(input.doctrine, input.scrumPrompt), input.userPrompt, input.model),
    generateModelMarkdown(composeSystemPrompt(input.doctrine, input.riskPrompt), input.userPrompt, input.model),
  ]);

  const roleNames = [
    "Product and scope",
    "Technical and architecture",
    "Delivery and Scrum planning",
    "Risk, quality, and operations",
  ];
  const [product, technical, scrum, risk] = roleResults.map((result, index) =>
    result.status === "fulfilled" ? result.value : buildModelFailureMemo(roleNames[index], result.reason));

  logOperationalEvent("ai_issue_planning_review.debate.completed", {});
  return { product, technical, scrum, risk };
}

/**
 * Workflow entrypoint for issue planning review.
 *
 * @returns {Promise<void>} Completes when comments are published.
 */
async function main() {
  const eventPath = readRequiredEnv("GITHUB_EVENT_PATH");
  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const model = readConfiguredModel();
  const promptPaths = {
    doctrine: process.env.AI_ISSUE_PLANNING_DOCTRINE_PATH?.trim() || ".github/prompts/ai-issue-planning-doctrine.md",
    product: process.env.AI_ISSUE_PLANNING_PRODUCT_PROMPT_PATH?.trim() || ".github/prompts/ai-issue-planning-product.md",
    technical: process.env.AI_ISSUE_PLANNING_TECHNICAL_PROMPT_PATH?.trim() || ".github/prompts/ai-issue-planning-technical.md",
    scrum: process.env.AI_ISSUE_PLANNING_SCRUM_PROMPT_PATH?.trim() || ".github/prompts/ai-issue-planning-scrum.md",
    risk: process.env.AI_ISSUE_PLANNING_RISK_PROMPT_PATH?.trim() || ".github/prompts/ai-issue-planning-risk.md",
  };
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const [owner, name] = repository.split("/");

  if (!owner || !name) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  const context = await resolvePlanningContext(event, owner, name, repository);

  if (!context) {
    return;
  }

  const [doctrine, productPrompt, technicalPrompt, scrumPrompt, riskPrompt, issueComments] = await Promise.all([
    readPrompt(promptPaths.doctrine),
    readPrompt(promptPaths.product),
    readPrompt(promptPaths.technical),
    readPrompt(promptPaths.scrum),
    readPrompt(promptPaths.risk),
    fetchIssueComments(repository, context.issue.number),
  ]);

  const referencedIssueNumbers = parseReferencedIssueNumbers(context.issue.body ?? "", context.issue.number);
  const childIssues = await Promise.all(referencedIssueNumbers.map((issueNumber) => fetchIssue(repository, issueNumber)));
  const discussionContext = buildDiscussionHistoryContext(context.discussion);

  // Package root issue, referenced issues, issue comments, and Discussion
  // history together so each role can judge both scope design and the debate
  // that already happened around that scope.
  const userPrompt = buildIssuePlanningUserPrompt(repository, context.issue, childIssues, issueComments, discussionContext);
  const debate = await runIssuePlanningDebate({
    model,
    doctrine,
    productPrompt,
    technicalPrompt,
    scrumPrompt,
    riskPrompt,
    userPrompt,
  });
  const evaluation = evaluateIssuePlanningRecommendation(debate);
  const discussionComments = buildIssuePlanningReviewComments(debate);

  // Publish specialist memos before the final status so the closing verdict
  // always points at review comments already visible in the Discussion.
  for (const comment of discussionComments) {
    await createDiscussionComment(context.discussion.id, comment.body);
    logOperationalEvent("ai_issue_planning_review.discussion_comment.published", {
      role: comment.role,
      discussionUrl: context.discussion.url,
    });
  }

  await createDiscussionComment(
    context.discussion.id,
    buildIssuePlanningCompletionComment(evaluation.recommendation, evaluation.blockingRoles),
  );
  logOperationalEvent("ai_issue_planning_review.final_comment.published", {
    recommendation: evaluation.recommendation,
    blockingRoles: evaluation.blockingRoles,
    discussionUrl: context.discussion.url,
  });

  if (evaluation.recommendation !== "Approve") {
    throw new Error("AI issue planning review requested changes. The workflow failed because the final recommendation is blocking.");
  }
}

/**
 * Execute the workflow only when this file is the active entrypoint.
 *
 * @returns {Promise<void>}
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
