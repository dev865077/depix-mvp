/**
 * Automated Wiki update runner.
 *
 * This script runs after a pull request is merged. It:
 * - reads the merged PR payload from GitHub Actions
 * - collects the PR files through the GitHub API
 * - sends the current docs/wiki pages plus bounded PR context to OpenAI
 * - validates the returned JSON update plan
 * - writes complete Markdown files under docs/wiki only
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WIKI_ROOT = "docs/wiki";
const MAX_FILES = 20;
const MAX_PATCH_CHARS_PER_FILE = 3500;
const MAX_PR_BODY_CHARS = 4000;
const MAX_WIKI_PAGE_CHARS = 7000;
const MAX_WIKI_INPUT_CHARS = 60000;
const MAX_MODEL_INPUT_CHARS = 90000;
const MAX_OUTPUT_TOKENS = 12000;

/**
 * Assert that an environment variable exists.
 *
 * @param {string} key Variable name.
 * @returns {string} Trimmed value.
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
 * @returns {string} Explicit model configured for this workflow.
 */
function readConfiguredModel() {
  const model = readRequiredEnv("OPENAI_WIKI_UPDATE_MODEL");

  if (/\s/.test(model)) {
    throw new Error("Invalid OPENAI_WIKI_UPDATE_MODEL: model name cannot contain whitespace.");
  }

  return model;
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
 * Read the repository-owned wiki maintenance prompt.
 *
 * @param {string} promptPath Path to the prompt file.
 * @returns {Promise<string>} Prompt content.
 */
async function readWikiPrompt(promptPath) {
  try {
    return await fs.readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read AI wiki prompt file at ${promptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
 * Turn GitHub's file payload into a bounded context bundle for the model.
 *
 * @param {any[]} files Changed files from GitHub.
 * @returns {string} Compact diff payload.
 */
function buildFilesPayload(files) {
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
 * List wiki Markdown files using stable alphabetical order.
 *
 * @param {string} wikiRoot Root wiki directory.
 * @returns {Promise<string[]>} Repository-relative Markdown paths.
 */
async function listWikiMarkdownFiles(wikiRoot = WIKI_ROOT) {
  const entries = await fs.readdir(wikiRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.posix.join(wikiRoot.replaceAll("\\", "/"), entry.name))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Read all current wiki pages into a bounded prompt section.
 *
 * @param {string[]} wikiPaths Repository-relative wiki paths.
 * @returns {Promise<string>} Prompt-ready wiki snapshot.
 */
async function buildWikiSnapshot(wikiPaths) {
  const sections = await Promise.all(wikiPaths.map(async (wikiPath) => {
    const content = await fs.readFile(wikiPath, "utf8");

    return [
      `### ${wikiPath}`,
      "```md",
      truncateText(content, MAX_WIKI_PAGE_CHARS),
      "```",
    ].join("\n");
  }));

  return truncateText(sections.join("\n\n"), MAX_WIKI_INPUT_CHARS);
}

/**
 * Extract a textual value from one content item returned by OpenAI.
 *
 * @param {any} contentItem One content item inside an output message.
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
 * Build a safe summary of the OpenAI response shape for diagnostics.
 *
 * @param {any} responseJson Raw OpenAI response JSON.
 * @returns {string} Compact JSON summary without prompt/wiki content.
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
      const extractedText = extractContentItemText(contentItem);

      if (extractedText) {
        textParts.push(extractedText);
      }
    }
  }

  return textParts.join("\n\n").trim();
}

/**
 * Ask OpenAI for a JSON wiki update plan.
 *
 * @param {string} systemPrompt Repository-specific wiki prompt.
 * @param {string} userPrompt PR and wiki payload.
 * @param {string} model Explicit model configured for the workflow.
 * @returns {Promise<string>} Raw JSON text.
 */
async function generateWikiUpdate(systemPrompt, userPrompt, model) {
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
  const updateText = readOpenAIText(responseJson);

  if (!updateText) {
    const responseSummary = summarizeOpenAIResponse(responseJson);

    if (responseJson?.status === "incomplete" && responseJson?.incomplete_details?.reason === "max_output_tokens") {
      throw new Error(`OpenAI exhausted max_output_tokens before producing wiki update JSON. Response summary: ${responseSummary}`);
    }

    throw new Error(`OpenAI returned an empty wiki update. Response summary: ${responseSummary}`);
  }

  return updateText;
}

/**
 * Parse JSON even when a model wraps it in a fenced block.
 *
 * @param {string} rawText Raw model output.
 * @returns {any} Parsed JSON value.
 */
export function parseWikiUpdateResponse(rawText) {
  const trimmedText = rawText.trim();
  const fencedMatch = trimmedText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fencedMatch ? fencedMatch[1].trim() : trimmedText;

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`AI wiki update did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Normalize and validate a wiki update path.
 *
 * @param {string} candidatePath Model-provided path.
 * @param {Set<string>} allowedPaths Existing docs/wiki Markdown paths.
 * @returns {string} Safe repository-relative wiki path.
 */
export function normalizeWikiUpdatePath(candidatePath, allowedPaths) {
  if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
    throw new Error("AI wiki update contains an empty path.");
  }

  const normalizedPath = candidatePath.trim().replaceAll("\\", "/").replace(/^\/+/, "");

  if (!normalizedPath.startsWith(`${WIKI_ROOT}/`) || !normalizedPath.endsWith(".md")) {
    throw new Error(`AI wiki update path is outside docs/wiki or is not Markdown: ${candidatePath}`);
  }

  if (normalizedPath.includes("..")) {
    throw new Error(`AI wiki update path contains traversal: ${candidatePath}`);
  }

  if (!allowedPaths.has(normalizedPath)) {
    throw new Error(`AI wiki update tried to modify an unknown wiki page: ${candidatePath}`);
  }

  return normalizedPath;
}

/**
 * Validate the model output before writing files.
 *
 * @param {any} rawPlan Parsed model JSON.
 * @param {string[]} wikiPaths Existing docs/wiki Markdown paths.
 * @returns {{ summary: string, updates: Array<{ path: string, content: string }> }} Safe update plan.
 */
export function assertValidWikiUpdatePlan(rawPlan, wikiPaths) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new Error("AI wiki update must be a JSON object.");
  }

  if (!Array.isArray(rawPlan.updates)) {
    throw new Error("AI wiki update must contain an updates array.");
  }

  const allowedPaths = new Set(wikiPaths.map((wikiPath) => wikiPath.replaceAll("\\", "/")));
  const seenPaths = new Set();
  const updates = rawPlan.updates.map((update) => {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw new Error("AI wiki update entries must be objects.");
    }

    const safePath = normalizeWikiUpdatePath(update.path, allowedPaths);

    if (seenPaths.has(safePath)) {
      throw new Error(`AI wiki update contains duplicate path: ${safePath}`);
    }

    seenPaths.add(safePath);

    if (typeof update.content !== "string" || update.content.trim().length === 0) {
      throw new Error(`AI wiki update content is empty for ${safePath}.`);
    }

    if (!update.content.trimStart().startsWith("#")) {
      throw new Error(`AI wiki update content must start with a Markdown heading for ${safePath}.`);
    }

    return {
      path: safePath,
      content: update.content.replace(/\s*$/u, "\n"),
    };
  });

  return {
    summary: typeof rawPlan.summary === "string" ? rawPlan.summary.trim() : "",
    updates,
  };
}

/**
 * Write validated wiki updates to disk.
 *
 * @param {{ updates: Array<{ path: string, content: string }> }} plan Safe update plan.
 * @returns {Promise<string[]>} Paths that changed on disk.
 */
export async function applyWikiUpdatePlan(plan) {
  const changedPaths = [];

  for (const update of plan.updates) {
    const currentContent = await fs.readFile(update.path, "utf8");

    if (currentContent === update.content) {
      continue;
    }

    await fs.writeFile(update.path, update.content, "utf8");
    changedPaths.push(update.path);
  }

  return changedPaths;
}

/**
 * Write a compact GitHub Actions summary when available.
 *
 * @param {{ summary: string, updates: Array<{ path: string }> }} plan Safe update plan.
 * @param {string[]} changedPaths Paths changed on disk.
 * @returns {Promise<void>} Completes when summary is written or skipped.
 */
async function writeStepSummary(plan, changedPaths) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryPath) {
    return;
  }

  const body = [
    "## AI Wiki Update",
    "",
    plan.summary || "No summary provided.",
    "",
    `Changed pages: ${changedPaths.length}`,
    ...changedPaths.map((changedPath) => `- ${changedPath}`),
    "",
  ].join("\n");

  await fs.appendFile(summaryPath, body, "utf8");
}

/**
 * Main workflow entrypoint.
 *
 * @returns {Promise<void>} Resolves when wiki pages are updated.
 */
async function main() {
  const eventPath = readRequiredEnv("GITHUB_EVENT_PATH");
  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const promptPath = process.env.AI_WIKI_PROMPT_PATH?.trim() || ".github/prompts/ai-wiki-update.md";
  const model = readConfiguredModel();
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const pullRequest = event.pull_request;

  if (!pullRequest) {
    throw new Error("This workflow only supports pull_request events.");
  }

  if (event.action !== "closed" || pullRequest.merged !== true) {
    console.log("Skipping wiki update because the PR was not merged.");
    return;
  }

  const wikiPaths = await listWikiMarkdownFiles();
  const [systemPrompt, files, wikiSnapshot] = await Promise.all([
    readWikiPrompt(promptPath),
    fetchPullRequestFiles(repository, pullRequest.number),
    buildWikiSnapshot(wikiPaths),
  ]);

  const userPrompt = truncateText([
    `Repository: ${repository}`,
    `Merged PR: #${pullRequest.number} - ${pullRequest.title}`,
    `Base branch: ${pullRequest.base.ref}`,
    `Head branch: ${pullRequest.head.ref}`,
    `Merged by: ${pullRequest.merged_by?.login ?? "[unknown]"}`,
    "",
    "## PR description",
    truncateText(pullRequest.body ?? "", MAX_PR_BODY_CHARS) || "[no description provided]",
    "",
    "## Changed files",
    buildFilesPayload(files),
    "",
    "## Current wiki pages",
    wikiSnapshot,
  ].join("\n"), MAX_MODEL_INPUT_CHARS);

  const rawUpdate = await generateWikiUpdate(systemPrompt, userPrompt, model);
  const plan = assertValidWikiUpdatePlan(parseWikiUpdateResponse(rawUpdate), wikiPaths);
  const changedPaths = await applyWikiUpdatePlan(plan);

  await writeStepSummary(plan, changedPaths);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
