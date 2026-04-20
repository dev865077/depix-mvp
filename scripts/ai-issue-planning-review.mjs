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
const ISSUE_PLANNING_STATUS_MARKER = "<!-- ai-issue-planning-status:openai -->";
const ISSUE_TRIAGE_COMMENT_MARKER = "<!-- ai-issue-triage:openai -->";
const ISSUE_TITLE_PREFIX = "[Issue #";
const ROUTE_DIRECT_PR = "direct_pr";
const ROUTE_DISCUSSION_BEFORE_PR = "discussion_before_pr";

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
 * The planning gate distinguishes real quality debt from normal dependency
 * blocking.
 *
 * `Blocked` means the issue is well specified but cannot start yet because one
 * or more explicit upstream dependencies still need to land. `Request changes`
 * remains the red state for backlog quality debt.
 */
const ALLOWED_RECOMMENDATIONS = new Set(["Approve", "Blocked", "Request changes"]);

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
 * Emit one GitHub Actions warning annotation for operator-visible soft failures.
 *
 * Optional context skips should still be visible in the Actions UI so the
 * operator can distinguish an intentional degraded run from a silent swallow.
 *
 * @param {string} message Warning body.
 * @returns {void}
 */
function emitWorkflowWarning(message) {
  console.warn(`::warning::${String(message).replace(/\r?\n/g, " ")}`);
}

/**
 * Write one GitHub Actions output when the workflow exposes GITHUB_OUTPUT.
 *
 * @param {string} key Output key.
 * @param {string} value Output value.
 * @returns {Promise<void>} Resolves when written or skipped.
 */
async function writeGitHubOutput(key, value) {
  const outputPath = process.env.GITHUB_OUTPUT;

  if (!outputPath) {
    return;
  }

  await fs.appendFile(outputPath, `${key}=${value}\n`, "utf8");
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
 * Validate that issue planning has only one automatic issue-to-planning entry.
 *
 * Triage owns issue events and explicitly dispatches this workflow. Planning
 * must not also listen to raw issue/comment events, otherwise the same issue can
 * race into two planning runs and create abandoned duplicate Discussions.
 *
 * @param {string} workflowText Workflow YAML text.
 * @returns {boolean} True when entrypoints are canonical.
 */
export function hasCanonicalIssuePlanningEntrypoints(workflowText) {
  return (
    typeof workflowText === "string"
    && /\bworkflow_dispatch\s*:/m.test(workflowText)
    && /\bdiscussion\s*:/m.test(workflowText)
    && /\bdiscussion_comment\s*:/m.test(workflowText)
    && !/^\s+issues\s*:\s*$/m.test(workflowText)
    && !/^\s+issue_comment\s*:\s*$/m.test(workflowText)
    && !workflowText.includes("contains(github.event.comment.body, '<!-- ai-issue-triage:openai -->')")
  );
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
 * Fetch repository metadata needed to create an issue-planning Discussion.
 *
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @returns {Promise<{
 *   id: string,
 *   hasDiscussionsEnabled: boolean,
 *   discussionCategories: { nodes: Array<{ id: string, name: string, isAnswerable: boolean }> },
 * }>} Repository metadata.
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
 * Choose a stable category for automated issue-planning Discussions.
 *
 * Selection order is configured category, `Ideas`, `General`, first
 * non-answerable category, then first category. This keeps the API-only
 * planning lane deterministic without requiring manual category setup.
 *
 * @param {Array<{ id: string, name: string, isAnswerable: boolean }>} categories Repository categories.
 * @param {string} [preferredName] Configured category name.
 * @returns {{ id: string, name: string, isAnswerable: boolean }} Selected category.
 */
export function selectPlanningDiscussionCategory(categories, preferredName = "") {
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

  return categories.find((category) => category.name.toLowerCase() === "ideas")
    ?? categories.find((category) => category.name.toLowerCase() === "general")
    ?? categories.find((category) => category.isAnswerable !== true)
    ?? categories[0];
}

/**
 * Create one GitHub Discussion for issue planning.
 *
 * @param {string} repositoryId Repository GraphQL node id.
 * @param {string} categoryId Discussion category node id.
 * @param {string} title Discussion title.
 * @param {string} body Discussion body.
 * @returns {Promise<{ id: string, number: number, url: string }>} Created discussion metadata.
 */
async function createPlanningDiscussion(repositoryId, categoryId, title, body) {
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
          number
          url
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(mutation, { repositoryId, categoryId, title, body });
  const discussion = data?.createDiscussion?.discussion;

  if (!discussion?.number || !discussion?.url) {
    throw new Error("GitHub GraphQL response did not include the created issue-planning Discussion.");
  }

  return discussion;
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

  if (cleanedValue === "blocked") {
    return "Blocked";
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
  const headingInlineMatch = reviewText.match(/^\s*#{1,6}\s*Recommendation\s*:?\s*(Approve|Blocked|Request changes)\s*$/im);

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
    throw new Error(`${role} issue-planning memo is missing the ## Recommendation section with Approve, Blocked, or Request changes.`);
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

  const uniqueIssueNumbers = new Set();
  const referencePattern = /#(\d+)/g;
  let match = referencePattern.exec(body);

  while (match) {
    const issueNumber = Number.parseInt(match[1], 10);
    const prefix = body.slice(Math.max(0, match.index - 32), match.index).toLowerCase();
    const isPullRequestExample = /\b(?:pr|pull request)\b[\s:()\-]*$/.test(prefix);

    if (!isPullRequestExample && Number.isInteger(issueNumber) && issueNumber > 0 && issueNumber !== rootIssueNumber) {
      uniqueIssueNumbers.add(issueNumber);
    }

    match = referencePattern.exec(body);
  }

  return [...uniqueIssueNumbers].sort((left, right) => left - right).slice(0, MAX_CHILD_ISSUES);
}

/**
 * Decide whether a referenced issue fetch error is ignorable for planning.
 *
 * Referenced issues enrich the planning payload, but they are optional context.
 * A prose example such as `PR #209` or an inaccessible historical issue should
 * not abort the whole planning run for the root issue.
 *
 * @param {unknown} error Fetch failure.
 * @returns {boolean} True when planning should skip that referenced issue.
 */
export function isIgnorableReferencedIssueFetchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const directStatus = typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : null;
  const nestedStatus = typeof error === "object" && error !== null && "response" in error
    && typeof error.response === "object" && error.response !== null && "status" in error.response
    ? Number(error.response.status)
    : null;
  const status = Number.isInteger(directStatus) ? directStatus : nestedStatus;

  if (status === 403 || status === 404) {
    return true;
  }

  return /GitHub API request failed \((403|404)\):/i.test(message);
}

/**
 * Resolve the skip reason for one inaccessible referenced issue fetch.
 *
 * @param {unknown} error Fetch failure.
 * @returns {"reference_forbidden" | "reference_not_found" | "reference_not_accessible"} Stable reason label.
 */
export function resolveReferencedIssueFetchSkipReason(error) {
  const directStatus = typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : null;
  const nestedStatus = typeof error === "object" && error !== null && "response" in error
    && typeof error.response === "object" && error.response !== null && "status" in error.response
    ? Number(error.response.status)
    : null;
  const status = Number.isInteger(directStatus) ? directStatus : nestedStatus;

  if (status === 403) {
    return "reference_forbidden";
  }

  if (status === 404) {
    return "reference_not_found";
  }

  return "reference_not_accessible";
}

/**
 * Fetch referenced child issues while skipping inaccessible optional context.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number[]} issueNumbers Candidate referenced issue numbers.
 * @param {{
 *   fetchIssueFn?: (repoFullName: string, issueNumber: number) => Promise<any>,
 *   logEventFn?: (event: string, fields?: Record<string, any>) => void,
 *   emitWarningFn?: (message: string) => void
 * }} [options] Test-friendly collaborators.
 * @returns {Promise<any[]>} Accessible referenced issues.
 */
export async function fetchReferencedChildIssues(repoFullName, issueNumbers, options = {}) {
  const fetchIssueFn = options.fetchIssueFn ?? fetchIssue;
  const logEventFn = options.logEventFn ?? logOperationalEvent;
  const emitWarningFn = options.emitWarningFn ?? emitWorkflowWarning;
  const results = await Promise.allSettled(issueNumbers.map((issueNumber) => fetchIssueFn(repoFullName, issueNumber)));
  const childIssues = [];

  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      childIssues.push(result.value);
      continue;
    }

    if (isIgnorableReferencedIssueFetchError(result.reason)) {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      const reason = resolveReferencedIssueFetchSkipReason(result.reason);
      const status = typeof result.reason === "object" && result.reason !== null && "status" in result.reason
        ? Number(result.reason.status)
        : typeof result.reason === "object" && result.reason !== null && "response" in result.reason
          && typeof result.reason.response === "object" && result.reason.response !== null && "status" in result.reason.response
          ? Number(result.reason.response.status)
          : null;

      logEventFn("ai_issue_planning_review.child_issue.skipped", {
        issueNumber: issueNumbers[index],
        reason,
        status: Number.isInteger(status) ? status : null,
        message,
      });
      emitWarningFn(
        `Planning skipped optional referenced issue #${issueNumbers[index]} (${reason}) and will continue without that child context.`,
      );
      continue;
    }

    throw result.reason;
  }

  return childIssues;
}

/**
 * Build a compact issue comment history for the planning prompt.
 *
 * Automated triage comments are intentionally excluded. They describe the
 * workflow contract that created the planning Discussion, not backlog scope.
 * Feeding that boilerplate back into the planning model makes the model treat
 * the existence of the gate itself as unresolved work, which can deadlock the
 * issue before a human or PR author has anything actionable to change.
 *
 * @param {any[]} comments Issue comments.
 * @returns {string} Bounded comment history.
 */
export function buildIssueCommentContext(comments) {
  const selectedComments = comments
    .filter((comment) => !isAutomatedIssueMetaComment(comment))
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
  const latestFinalComment = [...(discussion.comments?.nodes ?? [])]
    .reverse()
    .find((comment) => isAutomatedPlanningFinalComment(comment)) ?? null;

  for (const comment of discussion.comments?.nodes ?? []) {
    if (!isAutomatedPlanningComment(comment)) {
      entries.push([
        `### ${comment.author?.login ?? "unknown"} @ ${comment.createdAt ?? "unknown"}`,
        truncateText(comment.body ?? "[empty]", MAX_DISCUSSION_CONTEXT_COMMENT_CHARS),
      ].join("\n"));
    }
  }

  if (latestFinalComment) {
    const automatedEntries = [
      {
        body: latestFinalComment.body,
        createdAt: latestFinalComment.createdAt ?? "unknown",
      },
      ...(latestFinalComment.replies?.nodes ?? [])
        .filter((reply) => isAutomatedPlanningReply(reply))
        .map((reply) => ({
          body: reply.body,
          createdAt: reply.createdAt ?? "unknown",
        })),
    ];
    const latestAutomatedEntry = automatedEntries.at(-1);
    const humanReplies = (latestFinalComment.replies?.nodes ?? [])
      .filter((reply) => !isAutomatedPlanningReply(reply))
      .filter((reply) => typeof reply?.body === "string" && reply.body.trim().length > 0)
      .map((reply) => [
        `#### reply by ${reply.author?.login ?? "unknown"} @ ${reply.createdAt ?? "unknown"}`,
        truncateText(reply.body ?? "[empty]", MAX_DISCUSSION_CONTEXT_COMMENT_CHARS),
      ].join("\n"));

    entries.push([
      "## Latest planning conclusion thread",
      "Treat this thread as the current round handoff. Human replies here are the operator's response to the previous planning conclusion.",
      "",
      ...(latestAutomatedEntry
        ? [
          `### Previous automated conclusion @ ${latestAutomatedEntry.createdAt}`,
          truncateText(latestAutomatedEntry.body ?? "[empty]", MAX_DISCUSSION_CONTEXT_COMMENT_CHARS),
          "",
        ]
        : []),
      ...humanReplies,
    ].join("\n"));
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
 * Detecta replies automatizadas dentro da thread de conclusao do planning.
 *
 * @param {{ author?: { login?: string | null } | null, body?: string | null }} reply Reply GraphQL.
 * @returns {boolean} Verdadeiro apenas para replies automatizadas do bot.
 */
function isAutomatedPlanningReply(reply) {
  const authorLogin = reply?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && isAutomatedPlanningCommentBody(reply?.body);
}

/**
 * Detecta o comentario raiz de conclusao do planning review.
 *
 * @param {{ author?: { login?: string | null } | null, body?: string | null }} comment Comentario GraphQL.
 * @returns {boolean} Verdadeiro quando o comentario e a conclusao canonica.
 */
function isAutomatedPlanningFinalComment(comment) {
  const authorLogin = comment?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && typeof comment?.body === "string"
    && comment.body.trimStart().startsWith(DISCUSSION_FINAL_COMMENT_MARKER);
}

/**
 * Detecta comentarios automatizados de issue que sao metadados do fluxo.
 *
 * A triagem automatica cria a Discussion e explica que a rodada precisa de
 * unanimidade. Esse texto nao e criterio de aceite da issue; e instrucao do
 * proprio workflow. Se ele entrar no prompt, revisores podem reprovar porque
 * "a discussao ainda nao aprovou", mesmo quando a rodada atual esta decidindo
 * justamente essa aprovacao.
 *
 * @param {string | null | undefined} body Corpo bruto do comentario.
 * @returns {boolean} Verdadeiro quando o comentario e metadado automatizado.
 */
export function isAutomatedIssueMetaCommentBody(body) {
  if (typeof body !== "string") {
    return false;
  }

  const trimmedBody = body.trimStart();

  return trimmedBody.startsWith(ISSUE_TRIAGE_COMMENT_MARKER)
    || trimmedBody.startsWith(ISSUE_PLANNING_STATUS_MARKER)
    || trimmedBody.startsWith(DISCUSSION_COMMENT_MARKER)
    || trimmedBody.startsWith(DISCUSSION_FINAL_COMMENT_MARKER);
}

/**
 * Detecta comentarios REST de issue escritos pelo bot e marcados como meta.
 *
 * A checagem exige autor automatizado e marcador canonico para preservar
 * explicacoes humanas que citem esses marcadores ao descrever uma correcao.
 *
 * @param {{ user?: { login?: string | null } | null, body?: string | null }} comment Comentario REST de issue.
 * @returns {boolean} Verdadeiro apenas para metadados automatizados.
 */
export function isAutomatedIssueMetaComment(comment) {
  const authorLogin = comment?.user?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && isAutomatedIssueMetaCommentBody(comment?.body);
}

/**
 * Find the newest automated triage comment on an issue.
 *
 * @param {any[]} comments REST issue comments.
 * @returns {any | null} Latest triage comment or null.
 */
function findLatestTriageComment(comments) {
  return [...comments]
    .reverse()
    .find((comment) => {
      const authorLogin = comment?.user?.login;

      return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
        && typeof comment?.body === "string"
        && comment.body.trimStart().startsWith(ISSUE_TRIAGE_COMMENT_MARKER);
    }) ?? null;
}

/**
 * Extract the canonical triage route from the sticky triage comment.
 *
 * The parser accepts the new raw route line and older Portuguese labels so
 * planning reruns remain compatible with issues triaged before this contract.
 *
 * @param {string | null | undefined} body Triage comment body.
 * @returns {"direct_pr" | "discussion_before_pr" | null} Parsed route.
 */
export function extractIssueTriageRouteFromComment(body) {
  if (typeof body !== "string" || body.trim().length === 0) {
    return null;
  }

  const rawRouteMatch = body.match(/(?:Rota canonica|route)\s*:\s*`?(direct_pr|discussion_before_pr)`?/i);

  if (rawRouteMatch?.[1] === ROUTE_DIRECT_PR || rawRouteMatch?.[1] === ROUTE_DISCUSSION_BEFORE_PR) {
    return rawRouteMatch[1];
  }

  if (/Fluxo recomendado:\s*`?Discussion antes da PR`?/i.test(body)) {
    return ROUTE_DISCUSSION_BEFORE_PR;
  }

  if (/Fluxo recomendado:\s*`?PR direta`?/i.test(body)) {
    return ROUTE_DIRECT_PR;
  }

  return null;
}

/**
 * Extract the current triage route from issue comments.
 *
 * @param {any[]} comments REST issue comments.
 * @returns {"direct_pr" | "discussion_before_pr" | null} Parsed route.
 */
export function extractIssueTriageRouteFromComments(comments) {
  const triageComment = findLatestTriageComment(comments);

  return triageComment ? extractIssueTriageRouteFromComment(triageComment.body) : null;
}

/**
 * Build the root body for an issue-planning Discussion.
 *
 * @param {any} issue GitHub issue payload.
 * @param {string | null} triageCommentBody Latest triage comment body.
 * @returns {string} Markdown Discussion body.
 */
export function buildIssuePlanningDiscussionBody(issue, triageCommentBody = null) {
  return [
    `Issue origem: #${issue.number} - [${issue.title}](${issue.html_url ?? issue.url})`,
    "",
    "## Contrato",
    "Esta e a Discussion canonica de planning desta issue. Ela e criada e evoluida somente pela automacao via GitHub API ate produzir um estado canônico final.",
    "",
    "## Estado canonico inicial",
    "canonical_state: `issue_planning_in_progress`",
    "next_actor: `ai_issue_planning_review`",
    "next_action: `run_four_specialist_review`",
    "ready_for_codex: `false`",
    "ready_for_branch: `false`",
    "ready_for_pr: `false`",
    "",
    "## Contexto da issue",
    truncateText(issue.body ?? "[sem descricao]", MAX_ISSUE_BODY_CHARS),
    "",
    "## Triage",
    truncateText(triageCommentBody ?? "[sem triage automatica encontrada]", MAX_ISSUE_COMMENT_CHARS),
  ].join("\n");
}

/**
 * Build the issue-visible planning status comment consumed by Codex.
 *
 * @param {"Approve" | "Blocked" | "Request changes"} recommendation Final recommendation.
 * @param {string} discussionUrl Planning Discussion URL.
 * @param {string[]} [blockingRoles] Specialist roles still blocking.
 * @returns {string} Markdown issue status body.
 */
export function buildIssuePlanningStatusComment(recommendation, discussionUrl, blockingRoles = []) {
  const isApproved = recommendation === "Approve";
  const isBlocked = recommendation === "Blocked";
  const canonicalState = isApproved
    ? "issue_ready_for_codex"
    : isBlocked
      ? "issue_planning_blocked"
      : "issue_planning_request_changes";
  const nextActor = isApproved ? "codex" : isBlocked ? "dependency_owner" : "issue_author";
  const nextAction = isApproved ? "open_branch_and_pr" : isBlocked ? "wait_for_dependencies" : "reply_to_planning_conclusion";
  const blockerLine = !isApproved && blockingRoles.length > 0
    ? `blocking_roles: \`${blockingRoles.join(",")}\``
    : "blocking_roles: ``";

  return [
    ISSUE_PLANNING_STATUS_MARKER,
    "## AI Issue Planning Status",
    "",
    `Planning Discussion: ${discussionUrl}`,
    `Final recommendation: \`${recommendation}\``,
    "",
    "## Estado canonico",
    `canonical_state: \`${canonicalState}\``,
    `next_actor: \`${nextActor}\``,
    `next_action: \`${nextAction}\``,
    `ready_for_codex: \`${String(isApproved)}\``,
    `ready_for_branch: \`${String(isApproved)}\``,
    `ready_for_pr: \`${String(isApproved)}\``,
    `blocked_by_dependencies: \`${String(isBlocked)}\``,
    blockerLine,
  ].join("\n");
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
 *   recommendation: "Approve" | "Blocked" | "Request changes",
 *   recommendations: Record<string, string>,
 *   blockingRoles: string[],
 *   blockedRoles: string[],
 *   changeRequestRoles: string[]
 * }} Planning verdict.
 */
export function evaluateIssuePlanningRecommendation(debate) {
  const recommendations = {
    product: assertValidPlanningRecommendation("Product", debate.product),
    technical: assertValidPlanningRecommendation("Technical", debate.technical),
    scrum: assertValidPlanningRecommendation("Scrum", debate.scrum),
    risk: assertValidPlanningRecommendation("Risk", debate.risk),
  };
  const blockedRoles = Object.entries(recommendations)
    .filter(([, recommendation]) => recommendation === "Blocked")
    .map(([role]) => role);
  const changeRequestRoles = Object.entries(recommendations)
    .filter(([, recommendation]) => recommendation === "Request changes")
    .map(([role]) => role);
  const blockingRoles = [...new Set([...blockedRoles, ...changeRequestRoles])];
  let recommendation = "Approve";

  if (changeRequestRoles.length > 0) {
    recommendation = "Request changes";
  } else if (blockedRoles.length > 0) {
    recommendation = "Blocked";
  }

  return {
    recommendation,
    recommendations,
    blockingRoles,
    blockedRoles,
    changeRequestRoles,
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
 * @param {"Approve" | "Blocked" | "Request changes"} recommendation Final recommendation.
 * @param {string[]} [blockingRoles] Specialist roles still blocking.
 * @param {{ isFollowUpRound?: boolean }} [options] Rendering options.
 * @returns {string} Final status comment.
 */
export function buildIssuePlanningCompletionComment(recommendation, blockingRoles = [], options = {}) {
  const isApproved = recommendation === "Approve";
  const isBlocked = recommendation === "Blocked";
  const isFollowUpRound = options.isFollowUpRound === true;
  const statusLine = isApproved
    ? "Planning review concluded: all four specialist reviewer roles returned `Approve`."
    : isBlocked
      ? "Planning review concluded: the backlog artifact is well specified, but execution is still blocked by explicit upstream dependencies."
      : "Planning review concluded: unanimous approval was not reached across the specialist reviewer roles.";
  const closeLine = isApproved
    ? "This append-only comment is the visible readiness marker before implementation starts."
    : isBlocked
      ? "The planning Discussion remains open because at least one specialist reviewer role marked the work as `Blocked`, not because the artifact itself is under-specified."
      : "The planning Discussion remains open because at least one specialist reviewer role still requests changes.";
  const roundLine = isFollowUpRound
    ? isApproved
      ? "Why this passed now: the updated issue plus the operator replies in this conclusion thread resolved the previous planning blockers."
      : isBlocked
        ? "Round feedback: after re-reading the updated issue plus the operator replies in this conclusion thread, the artifact is now well specified but still waiting on explicit upstream dependencies."
        : "Round feedback: after re-reading the updated issue plus the operator replies in this conclusion thread, blocking planning gaps still remain."
    : null;
  const blockerLine = !isApproved && blockingRoles.length > 0
    ? `Blocking roles: ${blockingRoles.map((role) => `\`${role}\``).join(", ")}`
    : null;
  const canonicalState = isApproved
    ? "issue_ready_for_codex"
    : isBlocked
      ? "issue_planning_blocked"
      : "issue_planning_request_changes";
  const nextActor = isApproved ? "codex" : isBlocked ? "dependency_owner" : "issue_author";
  const nextAction = isApproved ? "open_branch_and_pr" : isBlocked ? "wait_for_dependencies" : "reply_to_planning_conclusion";
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
    ...(roundLine ? [roundLine] : []),
    ...(blockerLine ? [blockerLine] : []),
    policyLine,
    canonicalLine,
    "",
    "## Estado canonico",
    `canonical_state: \`${canonicalState}\``,
    `next_actor: \`${nextActor}\``,
    `next_action: \`${nextAction}\``,
    `ready_for_codex: \`${String(isApproved)}\``,
    `ready_for_branch: \`${String(isApproved)}\``,
    `ready_for_pr: \`${String(isApproved)}\``,
    `blocked_by_dependencies: \`${String(isBlocked)}\``,
    "",
    `Final recommendation: \`${recommendation}\``,
  ].join("\n");
}

/**
 * Publish one append-only discussion comment.
 *
 * @param {string} discussionId Discussion node id.
 * @param {string} body Markdown body.
 * @param {string | null} [replyToId] Existing Discussion comment id when replying to the prior conclusion.
 * @returns {Promise<void>} Completes when the comment is persisted.
 */
async function createDiscussionComment(discussionId, body, replyToId = null) {
  const mutation = `
    mutation($discussionId: ID!, $body: String!, $replyToId: ID) {
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
  await githubGraphqlRequest(mutation, { discussionId, body, replyToId });
}

/**
 * Create or update the issue-visible planning status comment.
 *
 * The issue comment is the handoff consumed by Codex after the API-only issue
 * planning lane finishes. It is sticky to avoid making Codex infer state from
 * a long Discussion history.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber Issue number.
 * @param {string} body Markdown body.
 * @returns {Promise<void>} Resolves when the status is persisted.
 */
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

/**
 * Close or reopen one Discussion so the GitHub UI reflects the current state.
 *
 * Approve closes the thread. Blocked and Request changes reopen it so the
 * next round can continue in-place.
 *
 * @param {string} discussionId Discussion node id.
 * @param {"Approve" | "Blocked" | "Request changes"} recommendation Final recommendation.
 * @returns {Promise<"closed" | "open">} Persisted lifecycle state.
 */
async function syncDiscussionLifecycle(discussionId, recommendation) {
  if (recommendation === "Approve") {
    const mutation = `
      mutation($discussionId: ID!) {
        closeDiscussion(input: {
          discussionId: $discussionId
        }) {
          discussion {
            id
            closed
          }
        }
      }
    `;
    await githubGraphqlRequest(mutation, { discussionId });
    return "closed";
  }

  const mutation = `
    mutation($discussionId: ID!) {
      reopenDiscussion(input: {
        discussionId: $discussionId
      }) {
        discussion {
          id
          closed
        }
      }
    }
  `;
  await githubGraphqlRequest(mutation, { discussionId });
  return "open";
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
 * Find an existing issue-planning Discussion by canonical issue title marker.
 *
 * This pure matcher is the dedupe contract used before creating a Discussion.
 * It keeps manual backfill and reruns from opening duplicate planning threads.
 *
 * @param {number} issueNumber Issue number.
 * @param {Array<{ number?: number, title?: string | null }>} discussions Recent Discussions.
 * @returns {number | null} Existing Discussion number when found.
 */
export function findMatchingIssuePlanningDiscussionNumber(issueNumber, discussions) {
  const matchingDiscussion = discussions.find((discussion) =>
    typeof discussion.title === "string" && discussion.title.includes(`${ISSUE_TITLE_PREFIX}${issueNumber}]`));

  return matchingDiscussion?.number ?? null;
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
 * Detect the only issue-comment event that is allowed to start planning.
 *
 * The workflow-level `if` uses the same marker, and this script-level guard is
 * the fail-closed backup. Plain issue comments, planning status comments, and
 * PR comments must not create or rerun issue-planning Discussions.
 *
 * @param {any} event Raw GitHub event payload.
 * @returns {boolean} True only for automated triage handoff comments on issues.
 */
export function isIssuePlanningHandoffCommentEvent(event) {
  if (!event?.comment || !event?.issue || event.issue.pull_request) {
    return false;
  }

  if (event.action && event.action !== "created") {
    return false;
  }

  const commentAuthor = event.comment.user?.login || event.comment.author?.login;

  if (commentAuthor !== "github-actions[bot]" && commentAuthor !== "github-actions") {
    return false;
  }

  const body = typeof event.comment.body === "string" ? event.comment.body : "";

  return body.includes(ISSUE_TRIAGE_COMMENT_MARKER);
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
 * Resolve a stable target key for workflow concurrency and logging.
 *
 * @param {any} event Raw GitHub event payload.
 * @returns {string | null} Stable target key or null.
 */
export function resolvePlanningConcurrencyTarget(event) {
  const manualTarget = parseManualPlanningTarget(event);

  if (manualTarget.discussionNumber) {
    return `manual-discussion-${manualTarget.discussionNumber}`;
  }

  if (manualTarget.issueNumber) {
    return `manual-issue-${manualTarget.issueNumber}`;
  }

  if (event?.issue?.number) {
    return `issue-${event.issue.number}`;
  }

  if (event?.discussion?.number) {
    return `discussion-${event.discussion.number}`;
  }

  return null;
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

  return findMatchingIssuePlanningDiscussionNumber(issueNumber, discussions);
}

/**
 * Create or reuse the canonical planning Discussion for one issue.
 *
 * Triage no longer creates Discussions. This function centralizes the API-only
 * planning lane so direct issues stay in issue comments, while complex issues
 * get exactly one four-specialist Discussion.
 *
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @param {any} issue GitHub issue payload.
 * @param {any[]} issueComments Current issue comments.
 * @returns {Promise<any>} Full Discussion payload.
 */
async function resolveIssuePlanningDiscussion(owner, name, issue, issueComments) {
  const existingDiscussionNumber = await findIssueDiscussionNumber(owner, name, issue.number, issueComments);

  if (existingDiscussionNumber) {
    return fetchDiscussionByNumber(owner, name, existingDiscussionNumber);
  }

  const repositoryMetadata = await fetchRepositoryDiscussionMetadata(owner, name);
  const preferredCategory = process.env.AI_ISSUE_PLANNING_DISCUSSION_CATEGORY?.trim()
    || process.env.AI_ISSUE_TRIAGE_DISCUSSION_CATEGORY?.trim()
    || "Ideas";
  const category = selectPlanningDiscussionCategory(repositoryMetadata.discussionCategories.nodes, preferredCategory);
  const triageComment = findLatestTriageComment(issueComments);
  const title = `${ISSUE_TITLE_PREFIX}${issue.number}] ${issue.title}`;
  const body = buildIssuePlanningDiscussionBody(issue, triageComment?.body ?? null);
  const createdDiscussion = await createPlanningDiscussion(repositoryMetadata.id, category.id, title, body);

  logOperationalEvent("ai_issue_planning_review.discussion.created", {
    issueNumber: issue.number,
    discussionNumber: createdDiscussion.number,
    discussionUrl: createdDiscussion.url,
  });

  return fetchDiscussionByNumber(owner, name, createdDiscussion.number);
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

  if (event?.inputs && !manualTarget.issueNumber && !manualTarget.discussionNumber) {
    throw new Error("workflow_dispatch for issue planning review requires issue_number or discussion_number.");
  }

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
    const discussion = await resolveIssuePlanningDiscussion(owner, name, issue, issueComments);
    return { issue, discussion };
  }

  if (event.comment && event.issue?.pull_request) {
    logOperationalEvent("ai_issue_planning_review.skip", {
      reason: "issue_comment_on_pull_request",
      issueNumber: event.issue.number,
    });
    return null;
  }

  if (event.comment && event.issue && !isIssuePlanningHandoffCommentEvent(event)) {
    logOperationalEvent("ai_issue_planning_review.skip", {
      reason: "issue_comment_not_triage_handoff",
      issueNumber: event.issue.number,
    });
    return null;
  }

  // Issue-triggered and triage-comment-triggered runs only enter the planning
  // lane when the sticky triage contract explicitly routes to planning.
  if (event.issue && !event.issue.pull_request) {
    if (event.issue.state !== "open") {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "issue_not_open",
        issueNumber: event.issue.number,
      });
      return null;
    }

    const issueComments = await fetchIssueComments(repository, event.issue.number);
    const triageRoute = extractIssueTriageRouteFromComments(issueComments);

    if (triageRoute !== ROUTE_DISCUSSION_BEFORE_PR) {
      logOperationalEvent("ai_issue_planning_review.skip", {
        reason: "issue_not_routed_to_planning",
        issueNumber: event.issue.number,
        triageRoute,
      });
      return null;
    }

    const discussion = await resolveIssuePlanningDiscussion(owner, name, event.issue, issueComments);
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
  const concurrencyTarget = resolvePlanningConcurrencyTarget(event);

  if (!owner || !name) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  if (!concurrencyTarget) {
    throw new Error("Unable to resolve a stable planning review target from the current event.");
  }

  logOperationalEvent("ai_issue_planning_review.target", { concurrencyTarget });

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
  const childIssues = await fetchReferencedChildIssues(repository, referencedIssueNumbers);
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
  const latestFinalComment = [...(context.discussion.comments?.nodes ?? [])]
    .reverse()
    .find((comment) => isAutomatedPlanningFinalComment(comment)) ?? null;

  // Publish specialist memos before the final status so the closing verdict
  // always points at review comments already visible in the Discussion.
  for (const comment of discussionComments) {
    await createDiscussionComment(context.discussion.id, comment.body);
  }

  await createDiscussionComment(
    context.discussion.id,
    buildIssuePlanningCompletionComment(
      evaluation.recommendation,
      evaluation.blockingRoles,
      { isFollowUpRound: Boolean(latestFinalComment) },
    ),
    latestFinalComment?.id ?? null,
  );

  await upsertIssuePlanningStatusComment(
    repository,
    context.issue.number,
    buildIssuePlanningStatusComment(evaluation.recommendation, context.discussion.url, evaluation.blockingRoles),
  );

  const lifecycleState = await syncDiscussionLifecycle(context.discussion.id, evaluation.recommendation);
  await Promise.all([
    writeGitHubOutput("planning_status", evaluation.recommendation.toLowerCase().replace(/\s+/g, "_")),
    writeGitHubOutput("blocking_roles", evaluation.blockingRoles.join(",")),
    writeGitHubOutput("blocked_by_dependencies", String(evaluation.recommendation === "Blocked")),
  ]);
  logOperationalEvent("ai_issue_planning_review.final_comment.published", {
    recommendation: evaluation.recommendation,
    blockingRoles: evaluation.blockingRoles,
    lifecycleState,
    discussionUrl: context.discussion.url,
  });

  if (evaluation.recommendation === "Request changes") {
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
