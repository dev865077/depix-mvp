/**
 * Automated PR review runner.
 *
 * This script is executed inside GitHub Actions on pull request events. It:
 * - reads the current PR payload from GitHub Actions
 * - collects the changed files and patches through the GitHub API
 * - sends a bounded review prompt to OpenAI
 * - creates or updates a single sticky PR comment with the AI review
 *
 * The first version intentionally publishes a comment only. It does not approve,
 * request changes, push commits, or mutate the PR branch.
 */
import fs from "node:fs/promises";

const REVIEW_MARKER = "<!-- ai-pr-review:openai -->";
const MAX_FILES = 20;
const MAX_PATCH_CHARS_PER_FILE = 6000;
const MAX_PR_BODY_CHARS = 4000;

/**
 * Assert that an environment variable exists.
 *
 * @param {string} key Variable name.
 * @returns {string} Sanitized value.
 */
function readRequiredEnv(key) {
  const value = process.env[key];

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

/**
 * Truncate a text block to a maximum size.
 *
 * @param {string | null | undefined} value Raw text.
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
 * Perform an authenticated GitHub API request.
 *
 * @param {string} url Full API URL.
 * @param {RequestInit} [init] Extra fetch options.
 * @returns {Promise<any>} Parsed JSON response.
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
 * Collect all changed files for the PR, handling GitHub pagination.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} pullRequestNumber PR number.
 * @returns {Promise<any[]>} Changed file entries from GitHub.
 */
async function fetchPullRequestFiles(repoFullName, pullRequestNumber) {
  const files = [];
  let page = 1;

  while (true) {
    const pageItems = await githubRequest(
      `https://api.github.com/repos/${repoFullName}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
    );

    files.push(...pageItems);

    if (pageItems.length < 100) {
      return files;
    }

    page += 1;
  }
}

/**
 * Turn GitHub's file payload into a bounded review bundle for the model.
 *
 * @param {any[]} files Changed files from GitHub.
 * @returns {string} Compact diff payload.
 */
function buildFilesReviewPayload(files) {
  const selectedFiles = files.slice(0, MAX_FILES);
  const sections = selectedFiles.map((file) => {
    const patch = truncateText(file.patch ?? "[no patch available]", MAX_PATCH_CHARS_PER_FILE);

    return [
      `### ${file.filename}`,
      `status: ${file.status}`,
      `additions: ${file.additions}`,
      `deletions: ${file.deletions}`,
      "",
      "```diff",
      patch,
      "```",
    ].join("\n");
  });

  if (files.length > MAX_FILES) {
    sections.push(`### Additional files omitted\nOnly the first ${MAX_FILES} changed files were sent to the model.`);
  }

  return sections.join("\n\n");
}

/**
 * Extract the plain text result from a Responses API payload.
 *
 * @param {any} responseJson Raw OpenAI response JSON.
 * @returns {string} Aggregated text.
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
      if (typeof contentItem.text === "string" && contentItem.text.trim().length > 0) {
        textParts.push(contentItem.text.trim());
      }
    }
  }

  return textParts.join("\n\n").trim();
}

/**
 * Send the review request to OpenAI.
 *
 * @param {string} systemPrompt Repository-specific review prompt.
 * @param {string} userPrompt PR review payload.
 * @returns {Promise<string>} Markdown review body.
 */
async function generateReview(systemPrompt, userPrompt) {
  const apiKey = readRequiredEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-5";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 1200,
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
    throw new Error(`OpenAI request failed (${response.status}): ${body}`);
  }

  const responseJson = await response.json();
  const reviewText = readOpenAIText(responseJson);

  if (!reviewText) {
    throw new Error("OpenAI returned an empty review.");
  }

  return reviewText;
}

/**
 * Create or update the sticky PR review comment.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber PR number as issue number.
 * @param {string} body Markdown comment body.
 * @returns {Promise<void>} Completes when the comment is persisted.
 */
async function upsertPullRequestComment(repoFullName, issueNumber, body) {
  const comments = await githubRequest(
    `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments?per_page=100`,
  );

  const existingComment = comments.find((comment) =>
    comment.user?.login === "github-actions[bot]" && typeof comment.body === "string" && comment.body.includes(REVIEW_MARKER));

  if (existingComment) {
    await githubRequest(
      `https://api.github.com/repos/${repoFullName}/issues/comments/${existingComment.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      },
    );

    return;
  }

  await githubRequest(
    `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
}

/**
 * Main workflow entrypoint.
 *
 * @returns {Promise<void>} Resolves when the PR comment is updated.
 */
async function main() {
  const eventPath = readRequiredEnv("GITHUB_EVENT_PATH");
  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const promptPath = process.env.AI_REVIEW_PROMPT_PATH?.trim() || ".github/prompts/ai-pr-review.md";
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const pullRequest = event.pull_request;

  if (!pullRequest) {
    throw new Error("This workflow only supports pull_request events.");
  }

  const [systemPrompt, files] = await Promise.all([
    fs.readFile(promptPath, "utf8"),
    fetchPullRequestFiles(repository, pullRequest.number),
  ]);

  const userPrompt = [
    `Repository: ${repository}`,
    `PR: #${pullRequest.number} - ${pullRequest.title}`,
    `Base branch: ${pullRequest.base.ref}`,
    `Head branch: ${pullRequest.head.ref}`,
    "",
    "## PR description",
    truncateText(pullRequest.body ?? "", MAX_PR_BODY_CHARS) || "[no description provided]",
    "",
    "## Changed files",
    buildFilesReviewPayload(files),
  ].join("\n");

  const review = await generateReview(systemPrompt, userPrompt);
  const commentBody = [
    REVIEW_MARKER,
    "## AI PR Review",
    "",
    `Model: \`${process.env.OPENAI_MODEL?.trim() || "gpt-5"}\``,
    "",
    review,
  ].join("\n");

  await upsertPullRequestComment(repository, pullRequest.number, commentBody);
}

await main();
