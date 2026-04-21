/**
 * Automated PR review runner.
 *
 * This workflow keeps two lanes:
 * - small, low-risk pull requests receive a direct sticky review comment
 * - broader pull requests are routed into a GitHub Discussion before merge,
 *   with one comment per AI reviewer role plus a synthesis comment
 */
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REVIEW_MARKER = "<!-- ai-pr-review:openai -->";
const DISCUSSION_ROUTE_DIRECT = "direct_review";
const DISCUSSION_ROUTE_REQUIRED = "discussion_before_merge";
const DISCUSSION_COMMENT_MARKER = "<!-- ai-pr-discussion-review:openai -->";
const DISCUSSION_FINAL_COMMENT_MARKER = "<!-- ai-pr-discussion-final:openai -->";
const DISCUSSION_SPECIALIST_ROLE_KEYS = ["product", "technical", "risk"];
const BLOCKER_CONTRACT_TESTABLE_FIELDS = [
  "Behavior protected",
  "Suggested test file",
  "Minimum scenario",
  "Essential assertions",
  "Resolution rule",
  "Why this test resolves the blocker",
];
const BLOCKER_CONTRACT_NOT_TESTABLE_FIELDS = [
  "Reason",
  "Required human resolution",
];
const BLOCKER_CONTRACT_FIELD_LABELS = [
  "Testability",
  ...BLOCKER_CONTRACT_TESTABLE_FIELDS,
  ...BLOCKER_CONTRACT_NOT_TESTABLE_FIELDS,
];
const BLOCKER_CONTRACT_REQUIRED_FIELDS_BY_TESTABILITY = {
  Testable: BLOCKER_CONTRACT_TESTABLE_FIELDS,
  "Not testable": BLOCKER_CONTRACT_NOT_TESTABLE_FIELDS,
};
const RUN_MODE_AUTO = "auto";
const RUN_MODE_CLASSIFY = "classify";
const RUN_MODE_DIRECT = "direct";
const RUN_MODE_DISCUSSION = "discussion";
const RUN_MODE_AWAIT_CI = "await_ci";
const MAX_FILES = 24;
const MAX_DISCUSSION_LOOKBACK = 100;
const MAX_DISCUSSION_CONTEXT_COMMENTS = 20;
const MAX_DISCUSSION_CONTEXT_CHARS = 16000;
const MAX_DISCUSSION_CONTEXT_COMMENT_CHARS = 1400;
const MAX_FAILURE_LOG_CONTEXT_CHARS = 12000;
const MAX_FAILURE_LOG_CHARS_PER_CHECK = 2400;
const MAX_PATCH_CHARS_PER_FILE = 7000;
const MAX_CRITICAL_PATCH_CHARS_PER_FILE = 50000;
const MAX_PR_BODY_CHARS = 3000;
const MAX_REVIEW_INPUT_CHARS = 200000;
const MAX_SYNTHESIS_INPUT_CHARS = 16000;
const MAX_AGENT_MEMO_CHARS = 2600;
const MAX_OUTPUT_TOKENS = 2200;
const OPENAI_REQUEST_TIMEOUT_MS = 120000;
const REASONING_EFFORT = "low";
const ALLOWED_RECOMMENDATIONS = new Set(["Approve", "Request changes"]);
const FORBIDDEN_RECOMMENDATIONS = ["Approve with minor follow-up", "Approve with later changes"];
const DIRECT_REVIEW_MAX_FILES = 3;
const DIRECT_REVIEW_MAX_TOTAL_LINES = 120;
const DIRECT_REVIEW_MAX_AREAS = 2;
const DIRECT_REVIEW_MAX_WORKFLOW_FILES = 2;
const DIRECT_REVIEW_MAX_WORKFLOW_LINES = 30;
const DIRECT_REVIEW_MAX_AUTOMATION_POLICY_FILES = 7;
const DIRECT_REVIEW_MAX_AUTOMATION_POLICY_LINES = 420;
const DISCUSSION_CATEGORY_DEFAULT = "";

const SENSITIVE_WORKFLOW_CHANGE_PATTERNS = [
  /\bpermissions\s*:/i,
  /\bpull_request_target\b/i,
  /\bsecrets\./i,
  /\bgithub_token\b/i,
  /\bcontents\s*:\s*write\b/i,
  /\bissues\s*:\s*write\b/i,
  /\bpull-requests\s*:\s*write\b/i,
  /\bdiscussions\s*:\s*write\b/i,
  /\bid-token\s*:\s*write\b/i,
];

const REVIEW_SIGNAL_BY_CATEGORY = {
  docs: 0,
  tests: 0,
  source: 3,
  workflow: 3,
  prompt: 2,
  config: 2,
  other: 2,
};

const REVIEW_FILE_PRIORITY_BY_CATEGORY = {
  source: 70,
  tests: 60,
  config: 50,
  workflow: 45,
  prompt: 40,
  docs: 30,
  other: 10,
};

const REVIEW_CRITICAL_PATH_PATTERNS = [
  /^src\/services\/ops-route-authorization\.js$/,
  /^src\/services\/eulen-deposit-recheck\.js$/,
  /^src\/routes\/ops\.js$/,
  /^src\/routes\/health\.js$/,
  /^src\/config\/runtime\.js$/,
  /^test\/deposit-recheck\.test\.js$/,
  /^test\/health\.test\.js$/,
  /^test\/runtime-config\.test\.js$/,
];

const DISCUSSION_ROLE_LABELS = {
  product: "product",
  technical: "technical",
  risk: "risk",
};

const DISCUSSION_ROLE_TITLES = {
  product: "Product and scope",
  technical: "Technical and architecture",
  risk: "Risk, security, and operations",
};
const TEST_FILE_REFERENCE_PATTERN = /(?:^|[^A-Za-z0-9_./-])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:test|spec)\.[A-Za-z0-9]+)(?=$|[^A-Za-z0-9_./-])/g;

/**
 * Emit a stable operational log line for GitHub Actions.
 *
 * @param {string} event Event name.
 * @param {Record<string, unknown>} fields Structured fields.
 * @returns {void}
 */
function logOperationalEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * Classify GitHub/API/log failures before treating a failed check as review
 * feedback.
 *
 * @param {string | Error | unknown} error Failure object or message.
 * @returns {"github_api_schema_error" | "github_api_permission_error" | "github_api_rate_limit" | "github_actions_log_error" | "unknown_operational_failure"} Stable class.
 */
export function classifyGitHubOperationalFailure(error) {
  const message = String(error instanceof Error ? error.message : error ?? "");

  if (/undefinedField|Field '[^']+' doesn't exist on type|doesn't exist on type/i.test(message)) {
    return "github_api_schema_error";
  }

  if (/Resource not accessible by integration|FORBIDDEN|403|permission|permissions/i.test(message)) {
    return "github_api_permission_error";
  }

  if (/rate limit|secondary rate limit|429/i.test(message)) {
    return "github_api_rate_limit";
  }

  if (/actions\/jobs\/\d+\/logs|job logs|log archive|logs/i.test(message)) {
    return "github_actions_log_error";
  }

  return "unknown_operational_failure";
}

/**
 * Normalize a repository file path for stable classification.
 *
 * @param {string} filename Raw GitHub file path.
 * @returns {string} Lower-cased slash-normalized path.
 */
function normalizeRepositoryPath(filename) {
  return typeof filename === "string" ? filename.replace(/\\/g, "/").toLowerCase() : "";
}

/**
 * Remove superficial Markdown formatting from a recommendation candidate.
 *
 * @param {string} value Raw text from the model.
 * @returns {string} Reduced value ready for comparison.
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
 * Normalize a recommendation candidate to one of the allowed values.
 *
 * @param {string} value Candidate recommendation text.
 * @returns {string | null} Valid recommendation or null.
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
 * Extract the final recommendation from a markdown review body.
 *
 * @param {string} reviewText Markdown review text generated by the model.
 * @returns {string | null} Recommendation when present.
 */
export function extractReviewRecommendation(reviewText) {
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

  const labelMatch = reviewText.match(/^\s*Recommendation\s*:?\s*(Approve|Request changes)\s*$/im);

  if (labelMatch) {
    return normalizeRecommendationCandidate(labelMatch[1]);
  }

  const firstNonEmptyLine = reviewText.split(/\r?\n/).find((line) => line.trim().length > 0);

  if (firstNonEmptyLine) {
    return normalizeRecommendationCandidate(firstNonEmptyLine);
  }

  return null;
}

/**
 * Normalize one blocker-contract value for equality checks.
 *
 * @param {string} value Raw field value.
 * @returns {string} Stable comparison value.
 */
function normalizeBlockerContractValue(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Extract the canonical blocker-contract section from one reviewer memo.
 *
 * The contract is only valid when the canonical fields live under the explicit
 * `## Blocker contract` heading. Free-floating labels elsewhere in the memo do
 * not count.
 *
 * @param {string} reviewText Reviewer memo markdown.
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }} Section body or malformed reason.
 */
function extractBlockerContractSection(reviewText) {
  const headingMatch = reviewText.match(/^\s*##\s*Blocker contract\s*$/im);

  if (!headingMatch || typeof headingMatch.index !== "number") {
    return { ok: false, reason: "Missing required section: ## Blocker contract." };
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const trailingText = reviewText.slice(sectionStart);
  const nextHeadingMatch = trailingText.match(/^\s*##\s+/m);
  const sectionBody = (nextHeadingMatch ? trailingText.slice(0, nextHeadingMatch.index) : trailingText).trim();

  return { ok: true, value: sectionBody };
}

/**
 * Collect canonical blocker-contract fields from one blocker-contract section.
 *
 * The parser accepts free ordering and multi-line field bodies inside the
 * blocker section. Unknown prose is ignored unless it reuses one of the
 * canonical field labels.
 *
 * @param {string} sectionText Reviewer memo blocker-contract section markdown.
 * @returns {Record<string, string[]>} Parsed raw field values grouped by label.
 */
function collectBlockerContractFields(sectionText) {
  const fields = Object.fromEntries(BLOCKER_CONTRACT_FIELD_LABELS.map((label) => [label, []]));
  let currentLabel = null;
  let currentLines = [];
  const isContinuationLine = (line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line) || /^\s{2,}\S/.test(line);

  const flushCurrentField = () => {
    if (!currentLabel) {
      return;
    }

    const value = currentLines.join("\n").trim();

    if (value.length > 0) {
      fields[currentLabel].push(value);
    }

    currentLabel = null;
    currentLines = [];
  };

  for (const line of sectionText.split(/\r?\n/)) {
    const labelMatch = line.match(/^\s*([^:]+):\s*(.*)$/);
    const label = labelMatch?.[1]?.trim() ?? null;

    if (label && BLOCKER_CONTRACT_FIELD_LABELS.includes(label)) {
      flushCurrentField();
      currentLabel = label;
      currentLines = [labelMatch?.[2] ?? ""];
      continue;
    }

    if (currentLabel && /^\s*##\s+/.test(line)) {
      flushCurrentField();
      continue;
    }

    if (currentLabel) {
      if (line.trim().length > 0 && !isContinuationLine(line)) {
        flushCurrentField();
        continue;
      }

      currentLines.push(line);
    }
  }

  flushCurrentField();
  return fields;
}

/**
 * Resolve one canonical blocker-contract field.
 *
 * Duplicate identical values are allowed and normalized. Conflicting duplicates
 * fail closed because they make the blocker contract ambiguous.
 *
 * @param {Record<string, string[]>} fields Parsed field map.
 * @param {string} label Canonical field label.
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }} Canonical value or malformed reason.
 */
function resolveCanonicalBlockerField(fields, label) {
  const values = fields[label] ?? [];

  if (values.length === 0) {
    return { ok: false, reason: `Missing required field: ${label}.` };
  }

  const normalizedValues = [...new Set(values.map(normalizeBlockerContractValue))];

  if (normalizedValues.length > 1) {
    return { ok: false, reason: `Conflicting duplicate field: ${label}.` };
  }

  const value = values[0]?.trim() ?? "";

  if (value.length === 0) {
    return { ok: false, reason: `Empty required field: ${label}.` };
  }

  return { ok: true, value };
}

/**
 * Parse the canonical blocker contract required for blocking specialist memos.
 *
 * @param {string} reviewText Reviewer memo markdown.
 * @returns {{
 *   status: "not_applicable" | "valid" | "malformed",
 *   testability?: "Testable" | "Not testable",
 *   fields?: Record<string, string>,
 *   reason?: string
 * }} Normalized contract result.
 */
export function parseBlockingRoleContract(reviewText) {
  const recommendation = assertValidReviewRecommendation(reviewText);

  if (recommendation !== "Request changes") {
    return { status: "not_applicable" };
  }

  const section = extractBlockerContractSection(reviewText);

  if (!section.ok) {
    return { status: "malformed", reason: section.reason };
  }

  const fields = collectBlockerContractFields(section.value);
  const testabilityField = resolveCanonicalBlockerField(fields, "Testability");

  if (!testabilityField.ok) {
    return { status: "malformed", reason: testabilityField.reason };
  }

  const testability = normalizeBlockerContractValue(testabilityField.value);

  if (testability !== "Testable" && testability !== "Not testable") {
    return {
      status: "malformed",
      reason: `Invalid Testability value: ${testability}. Expected Testable or Not testable.`,
    };
  }

  const requiredFields = BLOCKER_CONTRACT_REQUIRED_FIELDS_BY_TESTABILITY[testability];
  const resolvedFields = { Testability: testability };

  for (const label of requiredFields) {
    const resolvedField = resolveCanonicalBlockerField(fields, label);

    if (!resolvedField.ok) {
      return { status: "malformed", reason: resolvedField.reason };
    }

    resolvedFields[label] = resolvedField.value;
  }

  return {
    status: "valid",
    testability,
    fields: resolvedFields,
  };
}

/**
 * Build a synthetic blocking memo when the canonical blocker contract is absent
 * or malformed.
 *
 * @param {string} role Reviewer role label.
 * @param {string} reason Canonical malformed reason.
 * @returns {string} Safe fail-closed memo.
 */
export function buildMalformedBlockerContractMemo(role, reason) {
  return [
    "## Perspective",
    `The ${role} reviewer returned a blocking memo without the canonical blocker contract required by this repository.`,
    "",
    "## Findings",
    "- The blocking memo could not be parsed safely.",
    "- Contract status: Malformed",
    `- Malformed reason: ${reason}`,
    "- Required human resolution: regenerate the review with the canonical blocker contract",
    "",
    "## Questions",
    "- None.",
    "",
    "## Merge posture",
    "Request changes until the reviewer output follows the canonical blocker contract.",
    "",
    "## Blocker contract",
    "Testability: Not testable",
    `Reason: Malformed blocker contract from ${role}: ${reason}`,
    "Required human resolution: regenerate the review with the canonical blocker contract",
    "",
    "## Recommendation",
    "Request changes",
  ].join("\n");
}

/**
 * Enforce blocker-contract shape only for specialist memos that request changes.
 *
 * @param {string} role Human-readable reviewer role.
 * @param {string} reviewText Raw specialist memo.
 * @param {(reason: string) => void} [onMalformed] Optional malformed callback.
 * @returns {string} Original memo or deterministic malformed-contract memo.
 */
export function normalizeSpecialistReviewMemo(role, reviewText, onMalformed = () => {}) {
  const recommendation = assertValidReviewRecommendation(reviewText);

  if (recommendation === "Approve") {
    return reviewText;
  }

  const contract = parseBlockingRoleContract(reviewText);

  if (contract.status === "malformed") {
    onMalformed(contract.reason);
    return buildMalformedBlockerContractMemo(role, contract.reason);
  }

  return reviewText;
}

/**
 * Build a focused repair prompt for a malformed blocking specialist memo.
 *
 * @param {string} role Human-readable reviewer role.
 * @param {string} reviewText Raw malformed memo.
 * @param {string} reason Parser failure reason.
 * @returns {string} Repair-only user prompt.
 */
export function buildSpecialistReviewRepairUserPrompt(role, reviewText, reason) {
  return [
    `Repair this ${role} PR review memo so it follows the repository contract.`,
    "",
    "Rules:",
    "- Preserve the reviewer's real judgment.",
    "- If there is no material merge blocker, return a normal memo with `## Recommendation` set to `Approve`.",
    "- If there is a material merge blocker, return `## Recommendation` set to `Request changes` and include a valid `## Blocker contract` section.",
    "- Do not invent unrelated findings.",
    "- Return only the corrected markdown memo.",
    "",
    `Parser error: ${reason}`,
    "",
    "Malformed memo:",
    "```markdown",
    reviewText,
    "```",
  ].join("\n");
}

/**
 * Repair malformed blocking specialist memos once before failing closed.
 *
 * @param {string} role Human-readable reviewer role.
 * @param {string} reviewText Raw specialist memo.
 * @param {(reason: string) => Promise<string>} repairMemo Repair callback.
 * @param {(reason: string) => void} [onMalformed] Optional malformed callback.
 * @returns {Promise<string>} Original, repaired, or deterministic fail-closed memo.
 */
export async function normalizeOrRepairSpecialistReviewMemo(
  role,
  reviewText,
  repairMemo,
  onMalformed = () => {},
) {
  const recommendation = assertValidReviewRecommendation(reviewText);

  if (recommendation === "Approve") {
    return reviewText;
  }

  const contract = parseBlockingRoleContract(reviewText);

  if (contract.status !== "malformed") {
    return reviewText;
  }

  onMalformed(contract.reason);

  try {
    const repairedMemo = await repairMemo(contract.reason);
    const repairedRecommendation = assertValidReviewRecommendation(repairedMemo);

    if (repairedRecommendation === "Approve") {
      return repairedMemo;
    }

    const repairedContract = parseBlockingRoleContract(repairedMemo);

    if (repairedContract.status !== "malformed") {
      return repairedMemo;
    }

    const reason = `Repair still malformed: ${repairedContract.reason}`;
    onMalformed(reason);
    return buildMalformedBlockerContractMemo(role, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `Repair failed after malformed blocker contract: ${message}`;
    onMalformed(reason);
    return buildMalformedBlockerContractMemo(role, reason);
  }
}

/**
 * Collapse one blocker-contract field into a stable one-line summary value.
 *
 * @param {string} value Raw field value.
 * @returns {string} Markdown-safe compact value.
 */
function summarizeBlockerFieldValue(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Remove wrapping markdown code markers from one compact summary value.
 *
 * @param {string} value Raw value.
 * @returns {string} Value without outer backticks.
 */
function stripWrappingCodeMarkers(value) {
  return value.replace(/^`+/, "").replace(/`+$/, "").trim();
}

/**
 * Normalize text for deterministic diff-evidence matching.
 *
 * @param {string} value Raw text.
 * @returns {string} Lower-cased compact text.
 */
function normalizeComparableText(value) {
  return stripWrappingCodeMarkers(String(value ?? ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split one pipe-joined summary field back into stable discrete values.
 *
 * @param {string} value Compact summary field.
 * @returns {string[]} Stable non-empty values.
 */
function splitPipeJoinedSummaryValue(value) {
  return summarizeBlockerFieldValue(value)
    .split(/\s*\|\s*/)
    .map((item) => stripWrappingCodeMarkers(item))
    .filter((item) => item.length > 0);
}

/**
 * Extract one markdown section body by heading.
 *
 * @param {string} markdown Markdown body.
 * @param {string} heading Section heading without `##`.
 * @returns {string} Section body or an empty string.
 */
function extractMarkdownSectionBody(markdown, heading) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return "";
  }

  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingMatch = markdown.match(new RegExp(`^\\s*##\\s*${escapedHeading}\\s*$`, "im"));

  if (!headingMatch || typeof headingMatch.index !== "number") {
    return "";
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const trailingText = markdown.slice(sectionStart);
  const nextHeadingMatch = trailingText.match(/^\s*##\s+/m);

  return (nextHeadingMatch ? trailingText.slice(0, nextHeadingMatch.index) : trailingText).trim();
}

/**
 * Insert one value into an array only once after normalized comparison.
 *
 * @param {string[]} values Target array.
 * @param {string} value Candidate value.
 * @returns {void}
 */
function pushUniqueSummaryValue(values, value) {
  const normalizedCandidate = summarizeBlockerFieldValue(value);

  if (normalizedCandidate.length === 0) {
    return;
  }

  if (!values.some((currentValue) => summarizeBlockerFieldValue(currentValue) === normalizedCandidate)) {
    values.push(value.trim());
  }
}

/**
 * Parse the blocking specialist contracts already present in one debate.
 *
 * Only Product, Technical, and Risk count here. Synthesis is summary-only.
 *
 * @param {{ product: string, technical: string, risk: string, synthesis?: string }} debate Debate output.
 * @returns {Array<{
 *   role: "product" | "technical" | "risk",
 *   testability: "Testable" | "Not testable",
 *   fields: Record<string, string>
 * }>} Valid blocking contracts in deterministic role order.
 */
function collectDiscussionBlockingContracts(debate) {
  return DISCUSSION_SPECIALIST_ROLE_KEYS.flatMap((role) => {
    const parsed = parseBlockingRoleContract(debate[role]);

    if (parsed.status === "malformed") {
      return [{
        role,
        testability: "Not testable",
        fields: {
          Testability: "Not testable",
          Reason: `Malformed blocker contract from ${DISCUSSION_ROLE_TITLES[role] ?? role}: ${parsed.reason}`,
          "Required human resolution": "regenerate the review with the canonical blocker contract",
        },
      }];
    }

    if (parsed.status !== "valid" || !parsed.testability || !parsed.fields) {
      return [];
    }

    return [{
      role,
      testability: parsed.testability,
      fields: parsed.fields,
    }];
  });
}

/**
 * Consolidate blocking specialist contracts into stable synthesized summaries.
 *
 * Testable blockers can merge only when both `Behavior protected` and
 * `Suggested test file` match. Not-testable blockers always stay role-specific.
 *
 * @param {{ product: string, technical: string, risk: string, synthesis?: string }} debate Debate output.
 * @returns {{
 *   testable: Array<{
 *     roles: string[],
 *     behaviorProtected: string,
 *     suggestedTestFile: string,
 *     minimumScenarios: string[],
 *     essentialAssertions: string[],
 *     resolutionConditions: string[]
 *   }>,
 *   notTestable: Array<{
 *     role: string,
 *     reason: string,
 *     requiredHumanResolution: string
 *   }>,
 *   roleMap: Array<{
 *     role: string,
 *     expectedTest: string | null,
 *     resolutionCondition: string,
 *     behaviorProtected: string | null,
 *     testability: "Testable" | "Not testable",
 *     reason?: string
 *   }>
 * }} Consolidated blocker summary.
 */
export function summarizeDiscussionBlockingContracts(debate) {
  const groupedTestableContracts = new Map();
  const notTestableContracts = [];
  const roleMap = [];

  for (const contract of collectDiscussionBlockingContracts(debate)) {
    const roleLabel = DISCUSSION_ROLE_LABELS[contract.role] ?? contract.role;

    if (contract.testability === "Testable") {
      const behaviorProtected = summarizeBlockerFieldValue(contract.fields["Behavior protected"]);
      const suggestedTestFile = summarizeBlockerFieldValue(contract.fields["Suggested test file"]);
      const minimumScenario = summarizeBlockerFieldValue(contract.fields["Minimum scenario"]);
      const essentialAssertions = summarizeBlockerFieldValue(contract.fields["Essential assertions"]);
      const resolutionCondition = summarizeBlockerFieldValue(contract.fields["Resolution rule"]);
      const groupingKey = `${behaviorProtected}\u0000${suggestedTestFile}`;

      if (!groupedTestableContracts.has(groupingKey)) {
        groupedTestableContracts.set(groupingKey, {
          roles: [],
          behaviorProtected,
          suggestedTestFile,
          minimumScenarios: [],
          essentialAssertions: [],
          resolutionConditions: [],
        });
      }

      const groupedContract = groupedTestableContracts.get(groupingKey);
      pushUniqueSummaryValue(groupedContract.roles, roleLabel);
      pushUniqueSummaryValue(groupedContract.minimumScenarios, minimumScenario);
      pushUniqueSummaryValue(groupedContract.essentialAssertions, essentialAssertions);
      pushUniqueSummaryValue(groupedContract.resolutionConditions, resolutionCondition);

      roleMap.push({
        role: roleLabel,
        expectedTest: suggestedTestFile,
        resolutionCondition,
        behaviorProtected,
        testability: "Testable",
      });

      continue;
    }

    const reason = summarizeBlockerFieldValue(contract.fields.Reason);
    const requiredHumanResolution = summarizeBlockerFieldValue(contract.fields["Required human resolution"]);

    notTestableContracts.push({
      role: roleLabel,
      reason,
      requiredHumanResolution,
    });
    roleMap.push({
      role: roleLabel,
      expectedTest: null,
      resolutionCondition: requiredHumanResolution,
      behaviorProtected: null,
      testability: "Not testable",
      reason,
    });
  }

  return {
    testable: [...groupedTestableContracts.values()],
    notTestable: notTestableContracts,
    roleMap,
  };
}

/**
 * Render the canonical appendix for the synthesis comment.
 *
 * @param {ReturnType<typeof summarizeDiscussionBlockingContracts>} blockerSummary Consolidated blocker summary.
 * @returns {string[]} Markdown lines for the deterministic appendix.
 */
export function buildDiscussionSynthesisContractAppendix(blockerSummary) {
  const lines = [];

  if (blockerSummary.testable.length > 0) {
    lines.push("## Acceptance tests requested", "");

    for (const item of blockerSummary.testable) {
      lines.push(
        `- Roles ${item.roles.map((role) => `\`${role}\``).join(", ")} -> \`${item.suggestedTestFile}\`: protect ${item.behaviorProtected}; minimum scenario: ${item.minimumScenarios.join(" | ")}; essential assertions: ${item.essentialAssertions.join(" | ")}; resolution condition: ${item.resolutionConditions.join(" | ")}.`,
      );
    }
  }

  if (blockerSummary.notTestable.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push("## Human resolution required", "");

    for (const item of blockerSummary.notTestable) {
      lines.push(
        `- \`${item.role}\`: ${item.reason}; required human resolution: ${item.requiredHumanResolution}.`,
      );
    }
  }

  return lines;
}

/**
 * Insert one deterministic appendix before the recommendation section.
 *
 * @param {string} markdown Existing markdown body.
 * @param {string[]} appendixLines Appendix lines to insert.
 * @returns {string} Augmented markdown body.
 */
function insertAppendixBeforeRecommendation(markdown, appendixLines) {
  if (appendixLines.length === 0) {
    return markdown;
  }

  const recommendationHeadingMatch = markdown.match(/^\s*##\s*Recommendation\s*:?\s*$/im);

  if (!recommendationHeadingMatch || typeof recommendationHeadingMatch.index !== "number") {
    return [markdown.trimEnd(), "", ...appendixLines].join("\n");
  }

  const beforeRecommendation = markdown.slice(0, recommendationHeadingMatch.index).trimEnd();
  const recommendationAndAfter = markdown.slice(recommendationHeadingMatch.index).trimStart();

  return [beforeRecommendation, "", ...appendixLines, "", recommendationAndAfter].join("\n");
}

/**
 * Append deterministic blocker summaries to the synthesis memo.
 *
 * @param {string} synthesis Raw synthesis memo.
 * @param {{ product: string, technical: string, risk: string, synthesis?: string }} debate Debate output.
 * @returns {string} Augmented synthesis memo.
 */
export function augmentDiscussionSynthesis(synthesis, debate) {
  return insertAppendixBeforeRecommendation(
    synthesis,
    buildDiscussionSynthesisContractAppendix(summarizeDiscussionBlockingContracts(debate)),
  );
}

/**
 * Ensure that an environment variable exists and is not blank.
 *
 * @param {string} key Variable name.
 * @returns {string} Sanitized value.
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
  const model = readRequiredEnv("OPENAI_PR_REVIEW_MODEL");

  if (/\s/.test(model)) {
    throw new Error("Invalid OPENAI_PR_REVIEW_MODEL: model name cannot contain whitespace.");
  }

  if (model === "gpt-5.4-mini") {
    logOperationalEvent("ai_pr_review.model.default", {
      model,
      reason: "OPENAI_PR_REVIEW_MODEL was not configured and workflow default was used.",
    });
  } else {
    logOperationalEvent("ai_pr_review.model.configured", { model });
  }

  return model;
}

/**
 * Truncate text to a maximum size while keeping the payload readable.
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
 * Redact likely credentials from GitHub Actions logs before they enter any
 * model prompt.
 *
 * GitHub masks known secrets as `***`, but runtime logs can still contain
 * ad-hoc bearer tokens, API keys, or copied Authorization headers. Keep the
 * surrounding failure text readable while removing the secret literal.
 *
 * @param {string} logText Raw GitHub Actions log text.
 * @returns {string} Redacted log text safe for prompt context.
 */
export function redactActionsLogSecrets(logText) {
  return String(logText ?? "")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]")
    .replace(/\b(Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION)[A-Z0-9_]*)\s*([:=])\s*(['"]?)[^\s'"]+/gi,
      "$1$2$3[REDACTED]",
    )
    .replace(/\b(authorization\s*:\s*)(?:bearer|basic)?\s*[^\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@");
}

/**
 * Sanitize model-generated markdown before publishing it back to GitHub.
 *
 * Pull request titles, descriptions, and patches are untrusted model input. This
 * sanitizer keeps reviewer text readable while preventing generated output from
 * creating noisy mentions, active model-authored links, or markdown images.
 *
 * @param {string} markdown Raw model-generated markdown.
 * @returns {string} Markdown safe enough for automated public comments.
 */
export function sanitizePublishedMarkdown(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return "";
  }

  return markdown
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "Image omitted: $1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "`$1`")
    .replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)?)/g, "$1@<!-- -->$2");
}

/**
 * Reduce untrusted text before using it in a GitHub Discussion title.
 *
 * @param {string} value Raw title text.
 * @returns {string} Single-line title-safe text.
 */
function sanitizePlainTextForGitHubTitle(value) {
  return sanitizePublishedMarkdown(value)
    .replace(/[#*_`[\]()<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Create an AbortSignal for external API calls that must not hang CI forever.
 *
 * @returns {AbortSignal | undefined} Timeout signal when supported by Node.
 */
function createOpenAIRequestSignal() {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined;
  }

  return AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS);
}

/**
 * Read a repository-owned prompt file with a clear error when missing.
 *
 * @param {string} promptPath Path to the prompt file.
 * @returns {Promise<string>} Prompt content.
 */
async function readPrompt(promptPath) {
  try {
    return await fs.readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read prompt file at ${promptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Concatenate the shared doctrine with one role-specific prompt.
 *
 * @param {string} doctrine Shared review doctrine.
 * @param {string} rolePrompt Role-specific prompt.
 * @returns {string} Final system prompt.
 */
function composeSystemPrompt(doctrine, rolePrompt) {
  return [doctrine.trim(), "", "---", "", rolePrompt.trim()].join("\n");
}

/**
 * Perform an authenticated GitHub REST API request.
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

  return parseGitHubRestResponse(response);
}

/**
 * Parse one successful GitHub REST response without misclassifying empty bodies.
 *
 * Real `Response` objects can be safely previewed with `clone()`. Test doubles
 * often expose `json()` directly without a real stream body, so the fallback
 * remains explicit for those mocks.
 *
 * @param {{ status?: number, clone?: () => { text: () => Promise<string> }, text?: () => Promise<string>, json?: () => Promise<any> }} response Response-like object.
 * @returns {Promise<any>} Parsed payload or null for empty/no-content bodies.
 */
export async function parseGitHubRestResponse(response) {
  if (response?.status === 204) {
    return null;
  }

  if (typeof response?.clone === "function") {
    const preview = await response.clone().text();

    if (preview.trim().length === 0) {
      return null;
    }

    return response.json();
  }

  const body = typeof response?.text === "function" ? await response.text() : "";

  if (body.trim().length > 0) {
    return JSON.parse(body);
  }

  if (typeof response?.json === "function") {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Perform an authenticated GitHub REST API request and return raw text.
 *
 * @param {string} url Full API URL.
 * @param {RequestInit} [init] Extra fetch options.
 * @returns {Promise<string>} Raw response body.
 */
async function githubRequestText(url, init = {}) {
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

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${url}: ${body}`);
  }

  return body;
}

/**
 * Perform an authenticated GitHub GraphQL request.
 *
 * @param {string} query GraphQL document.
 * @param {Record<string, unknown>} variables GraphQL variables.
 * @returns {Promise<any>} Parsed data field.
 */
async function githubGraphqlRequest(query, variables) {
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

  const body = await response.json();

  if (!response.ok || Array.isArray(body.errors) && body.errors.length > 0) {
    const error = new Error(`GitHub GraphQL request failed: ${JSON.stringify(body.errors ?? body)}`);

    logOperationalEvent("ai_pr_review.github_graphql.failure", {
      failureClass: classifyGitHubOperationalFailure(error),
    });

    throw error;
  }

  return body.data;
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
 * Fetch one pull request by number.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} pullRequestNumber PR number.
 * @returns {Promise<any>} Pull request payload.
 */
async function fetchPullRequest(repoFullName, pullRequestNumber) {
  return githubRequest(`https://api.github.com/repos/${repoFullName}/pulls/${pullRequestNumber}`);
}

/**
 * Fetch the current pull-request status-check rollup contexts.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} pullRequestNumber PR number.
 * @returns {Promise<Array<any>>} Status-check contexts for the current head commit.
 */
async function fetchPullRequestStatusCheckRollup(repoFullName, pullRequestNumber) {
  const pullRequest = await githubRequest(`https://api.github.com/repos/${repoFullName}/pulls/${pullRequestNumber}`);
  const headSha = pullRequest?.head?.sha;

  if (!headSha) {
    return [];
  }

  try {
    const data = await githubRequest(
      `https://api.github.com/repos/${repoFullName}/actions/runs?head_sha=${headSha}&per_page=100`,
    );

    return (Array.isArray(data?.workflow_runs) ? data.workflow_runs : [])
      .filter((workflowRun) => workflowRun?.name === "CI")
      .map((workflowRun) => ({
        __typename: "StatusContext",
        context: "CI / Test",
        state: workflowRun?.conclusion ?? workflowRun?.status ?? "",
      }));
  } catch (error) {
    if (/Resource not accessible by integration/i.test(String(error?.message ?? error))) {
      logOperationalEvent("ai_pr_review.follow_up_status_rollup.unavailable", {
        repository: repoFullName,
        pullRequestNumber,
        reason: "resource_not_accessible_by_integration",
      });
      return [];
    }
    throw error;
  }
}

/**
 * Extract a GitHub Actions job id from one check-run details URL.
 *
 * @param {string | undefined} detailsUrl Check-run details URL.
 * @returns {string | null} Job id when the URL points at a GitHub Actions job.
 */
function extractActionsJobId(detailsUrl) {
  const match = String(detailsUrl ?? "").match(/\/actions\/runs\/\d+\/job\/(\d+)(?:\?|$)/);

  return match?.[1] ?? null;
}

/**
 * Render failed check logs into a bounded prompt block.
 *
 * @param {Array<{
 *   name?: string,
 *   conclusion?: string,
 *   status?: string,
 *   details_url?: string,
 *   html_url?: string,
 *   output?: { title?: string, summary?: string, text?: string },
 *   logText?: string,
 *   logFailureClass?: string,
 *   logFailureMessage?: string
 * }>} checkRuns Check runs with optional fetched log text.
 * @returns {string} Markdown context block.
 */
export function buildFailedActionsLogContext(checkRuns) {
  const failedRuns = (Array.isArray(checkRuns) ? checkRuns : [])
    .filter((checkRun) => ["failure", "timed_out", "cancelled", "action_required"].includes(String(checkRun?.conclusion ?? "").toLowerCase()));

  if (failedRuns.length === 0) {
    return "";
  }

  const sections = failedRuns.map((checkRun) => {
    const logBody = checkRun.logText
      ? truncateText(redactActionsLogSecrets(checkRun.logText), MAX_FAILURE_LOG_CHARS_PER_CHECK)
      : [
        checkRun.logFailureClass ? `Log fetch classification: ${checkRun.logFailureClass}` : "",
        checkRun.logFailureMessage ? `Log fetch failure: ${checkRun.logFailureMessage}` : "",
        checkRun.output?.title ? `Output title: ${checkRun.output.title}` : "",
        checkRun.output?.summary ? `Output summary: ${checkRun.output.summary}` : "",
        checkRun.output?.text ? `Output text: ${checkRun.output.text}` : "",
      ].filter(Boolean).join("\n");
    const safeLogBody = logBody
      ? truncateText(redactActionsLogSecrets(logBody), MAX_FAILURE_LOG_CHARS_PER_CHECK)
      : "[no log body available]";

    return [
      `### ${checkRun.name ?? "Unnamed check"}`,
      `conclusion: ${checkRun.conclusion ?? "unknown"}`,
      `status: ${checkRun.status ?? "unknown"}`,
      `details: ${checkRun.details_url ?? checkRun.html_url ?? "unknown"}`,
      "",
      "```text",
      sanitizePublishedMarkdown(safeLogBody),
      "```",
    ].join("\n");
  });

  return truncateText([
    "## Failing GitHub Actions logs",
    "Use these real check logs to distinguish automation/runtime failures from reviewer-requested changes.",
    "",
    ...sections,
  ].join("\n\n"), MAX_FAILURE_LOG_CONTEXT_CHARS);
}

/**
 * Load failed GitHub Actions check logs for the current PR head.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} pullRequestNumber PR number.
 * @returns {Promise<string>} Markdown context block, or an empty string.
 */
async function loadFailedActionsLogContext(repoFullName, pullRequestNumber) {
  try {
    const pullRequest = await fetchPullRequest(repoFullName, pullRequestNumber);
    const headSha = pullRequest?.head?.sha;

    if (!headSha) {
      return "";
    }

    const checkRunResponse = await githubRequest(
      `https://api.github.com/repos/${repoFullName}/commits/${headSha}/check-runs?per_page=100`,
      {
        headers: {
          Accept: "application/vnd.github+json",
        },
      },
    );
    const failedCheckRuns = (Array.isArray(checkRunResponse?.check_runs) ? checkRunResponse.check_runs : [])
      .filter((checkRun) => ["failure", "timed_out", "cancelled", "action_required"].includes(String(checkRun?.conclusion ?? "").toLowerCase()));
    const enrichedCheckRuns = await Promise.all(failedCheckRuns.map(async (checkRun) => {
      const jobId = extractActionsJobId(checkRun.details_url);

      if (!jobId) {
        return checkRun;
      }

      try {
        const logText = await githubRequestText(`https://api.github.com/repos/${repoFullName}/actions/jobs/${jobId}/logs`);

        return { ...checkRun, logText };
      } catch (error) {
        return {
          ...checkRun,
          logFailureClass: classifyGitHubOperationalFailure(error),
          logFailureMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    return buildFailedActionsLogContext(enrichedCheckRuns);
  } catch (error) {
    logOperationalEvent("ai_pr_review.failed_actions_logs.unavailable", {
      repository: repoFullName,
      pullRequestNumber,
      failureClass: classifyGitHubOperationalFailure(error),
      reason: error instanceof Error ? error.message : String(error),
    });

    return "";
  }
}

/**
 * Fetch PR comments. Pull request comments are issue comments under the hood.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber PR number as issue number.
 * @returns {Promise<any[]>} PR comments.
 */
async function fetchPullRequestComments(repoFullName, issueNumber) {
  return githubRequest(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments?per_page=100`);
}

/**
 * Fetch repository discussion metadata needed for category selection and
 * discussion deduplication/commenting.
 *
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @returns {Promise<{
 *   id: string,
 *   hasDiscussionsEnabled: boolean,
 *   discussionCategories: { nodes: Array<{ id: string, name: string, isAnswerable: boolean }> },
 *   discussions: { nodes: Array<{ id: string, title: string, url: string }> },
 * }>} Repository discussion metadata.
 */
async function fetchRepositoryDiscussionMetadata(owner, name) {
  const query = `
    query($owner: String!, $name: String!, $limit: Int!) {
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
        discussions(first: $limit, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes {
            id
            title
            url
          }
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(query, { owner, name, limit: MAX_DISCUSSION_LOOKBACK });
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
 * Fetch recent comments from an existing GitHub Discussion.
 *
 * @param {string} discussionId GitHub GraphQL node id.
 * @returns {Promise<any[]>} Recent comments with one reply level.
 */
async function fetchDiscussionComments(discussionId) {
  const query = `
    query($discussionId: ID!, $limit: Int!) {
      node(id: $discussionId) {
        ... on Discussion {
          comments(last: $limit) {
            nodes {
              id
              publishedAt
              author {
                login
              }
              body
              replies(last: 20) {
                nodes {
                  id
                  createdAt
                  author {
                    login
                  }
                  body
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(query, {
    discussionId,
    limit: MAX_DISCUSSION_CONTEXT_COMMENTS,
  });

  return data?.node?.comments?.nodes ?? [];
}

/**
 * Choose the safest discussion category for automated design debate.
 *
 * @param {Array<{ id: string, name: string, isAnswerable: boolean }>} categories Repository categories.
 * @param {string} [preferredName] Optional configured category name.
 * @returns {{ id: string, name: string, isAnswerable: boolean }} Selected category.
 */
export function selectDiscussionCategory(categories, preferredName = "") {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("No GitHub Discussion categories are available in this repository. Enable Discussions or create at least one category before using discussion-review.");
  }

  const normalizedPreferredName = preferredName.trim().toLowerCase();

  if (normalizedPreferredName) {
    const preferredCategory = categories.find((category) => category.name.toLowerCase() === normalizedPreferredName);

    if (preferredCategory) {
      logOperationalEvent("ai_pr_review.discussion_category.selected", {
        category: preferredCategory.name,
        source: "configured",
      });

      return preferredCategory;
    }

    logOperationalEvent("ai_pr_review.discussion_category.configured_missing", {
      configuredCategory: preferredName,
      availableCategories: categories.map((category) => category.name),
    });
  }

  const ideasCategory = categories.find((category) => category.name.toLowerCase() === "ideas");

  if (ideasCategory) {
    logOperationalEvent("ai_pr_review.discussion_category.selected", {
      category: ideasCategory.name,
      source: "ideas_fallback",
    });

    return ideasCategory;
  }

  const generalCategory = categories.find((category) => category.name.toLowerCase() === "general");

  if (generalCategory) {
    logOperationalEvent("ai_pr_review.discussion_category.selected", {
      category: generalCategory.name,
      source: "general_fallback",
    });

    return generalCategory;
  }

  const firstOpenEndedCategory = categories.find((category) => category.isAnswerable !== true);

  if (firstOpenEndedCategory) {
    logOperationalEvent("ai_pr_review.discussion_category.selected", {
      category: firstOpenEndedCategory.name,
      source: "first_open_category",
    });

    return firstOpenEndedCategory;
  }

  logOperationalEvent("ai_pr_review.discussion_category.selected", {
    category: categories[0].name,
    source: "first_available_category",
  });

  return categories[0];
}

/**
 * Extract a GitHub Discussion URL from a sticky PR comment body.
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
 * Find the existing sticky PR review comment generated by this workflow.
 *
 * @param {any[]} comments PR comments.
 * @returns {any | null} Existing sticky comment or null.
 */
function findExistingReviewComment(comments) {
  return comments.find((comment) =>
    comment.user?.login === "github-actions[bot]" &&
    typeof comment.body === "string" &&
    comment.body.includes(REVIEW_MARKER)) ?? null;
}

/**
 * Find a pre-existing Discussion for the current PR to avoid duplication.
 *
 * @param {number} pullRequestNumber PR number.
 * @param {any[]} comments PR comments.
 * @param {Array<{ id: string, title: string, url: string }>} discussions Recent discussions.
 * @returns {{ id?: string, url: string } | null} Existing discussion target.
 */
function findExistingDiscussionTarget(pullRequestNumber, comments, discussions) {
  const stickyComment = findExistingReviewComment(comments);
  const commentDiscussionUrl = stickyComment ? extractDiscussionUrlFromComment(stickyComment.body) : null;

  if (commentDiscussionUrl) {
    const matchingDiscussion = discussions.find((discussion) => discussion.url === commentDiscussionUrl);

    if (matchingDiscussion) {
      return { id: matchingDiscussion.id, url: matchingDiscussion.url };
    }

    return {
      number: parseDiscussionNumberFromUrl(commentDiscussionUrl),
      url: commentDiscussionUrl,
    };
  }

  const issueMarker = `[PR #${pullRequestNumber}]`;
  const matchingDiscussion = discussions.find((discussion) =>
    typeof discussion.title === "string" && discussion.title.includes(issueMarker));

  return matchingDiscussion ? { id: matchingDiscussion.id, url: matchingDiscussion.url } : null;
}

/**
 * Extract a numeric GitHub Discussion number from a repository discussion URL.
 *
 * @param {string} url GitHub Discussion URL.
 * @returns {number | null} Parsed discussion number when present.
 */
function parseDiscussionNumberFromUrl(url) {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }

  const match = url.match(/\/discussions\/(\d+)(?:$|[?#/])/i);

  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);

  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Fetch one repository discussion by number so reruns can recover the canonical
 * Discussion even when it fell outside the recent lookback window.
 *
 * @param {string} owner Repository owner.
 * @param {string} name Repository name.
 * @param {number} discussionNumber Discussion number.
 * @returns {Promise<any | null>} Discussion metadata or null.
 */
async function fetchDiscussionByNumber(owner, name, discussionNumber) {
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $limit: Int!) {
      repository(owner: $owner, name: $name) {
        discussion(number: $number) {
          id
          number
          title
          body
          url
          closed
          comments(last: $limit) {
            nodes {
              id
              publishedAt
              author {
                login
              }
              body
              replies(last: 20) {
                nodes {
                  id
                  createdAt
                  author {
                    login
                  }
                  body
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(query, {
    owner,
    name,
    number: discussionNumber,
    limit: MAX_DISCUSSION_CONTEXT_COMMENTS,
  });

  return data?.repository?.discussion ?? null;
}

/**
 * Prefer the repository-reloaded Discussion object over the raw mutation
 * payload so later comment queries use the canonical node id.
 *
 * @param {{ id?: string, number?: number, url: string }} createdDiscussion Newly created Discussion.
 * @param {{ id?: string, number?: number, url?: string } | null} recoveredDiscussion Repository-fetched Discussion.
 * @returns {{ id?: string, number?: number, url: string }} Canonical Discussion target for publication.
 */
export function preferRecoveredDiscussionTarget(createdDiscussion, recoveredDiscussion) {
  if (recoveredDiscussion?.id && recoveredDiscussion?.url) {
    return recoveredDiscussion;
  }

  return createdDiscussion;
}

/**
 * Detect one automation-authored PR Discussion comment body so reruns do not
 * feed stale bot findings back into the next model round.
 *
 * @param {string} body Discussion comment body.
 * @returns {boolean} True when the body belongs to this automation.
 */
function isAutomatedDiscussionCommentBody(body) {
  if (typeof body !== "string") {
    return false;
  }

  const trimmedBody = body.trimStart();

  return trimmedBody.startsWith(DISCUSSION_COMMENT_MARKER)
    || trimmedBody.startsWith(DISCUSSION_FINAL_COMMENT_MARKER);
}

/**
 * Decide whether one Discussion comment should be treated as automation noise.
 *
 * Human replies that quote automation markers are still useful operational
 * context, so filtering only applies to actual bot-authored comments.
 *
 * @param {{ author?: { login?: string }, body?: string }} comment Discussion comment.
 * @returns {boolean} True when this comment came from the automation itself.
 */
function isAutomatedDiscussionComment(comment) {
  const authorLogin = comment?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && isAutomatedDiscussionCommentBody(comment?.body);
}

/**
 * Detect one automation-authored Discussion event so reply-triggered reruns do
 * not recurse on comments published by this workflow.
 *
 * @param {any} event Raw GitHub event payload.
 * @returns {boolean} True when the current event comment belongs to the bot.
 */
function isAutomationDiscussionCommentEvent(event) {
  const authorLogin = event?.comment?.user?.login ?? event?.comment?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && isAutomatedDiscussionCommentBody(event?.comment?.body);
}

/**
 * Extract the PR number attached to a GitHub Actions workflow_run event.
 *
 * @param {any} event Raw GitHub event payload.
 * @returns {number | null} Pull request number when the workflow run is linked to one PR.
 */
export function extractPullRequestNumberFromWorkflowRunEvent(event) {
  const pullRequests = Array.isArray(event?.workflow_run?.pull_requests)
    ? event.workflow_run.pull_requests
    : [];
  const [pullRequest] = pullRequests;
  const pullRequestNumber = Number(pullRequest?.number);

  return Number.isInteger(pullRequestNumber) && pullRequestNumber > 0
    ? pullRequestNumber
    : null;
}

/**
 * Decide whether a workflow_run payload is eligible to wake PR review.
 *
 * @param {any} event Raw GitHub event payload.
 * @returns {boolean} True when CI completed for a pull request.
 */
export function isCompletedCiWorkflowRunEvent(event) {
  return event?.workflow_run?.name === "CI"
    && event?.workflow_run?.status === "completed"
    && Boolean(extractPullRequestNumberFromWorkflowRunEvent(event));
}

/**
 * Detect one automation-authored reply in the conclusion thread.
 *
 * @param {any} reply Discussion reply payload.
 * @returns {boolean} True when the reply came from the automation.
 */
function isAutomatedDiscussionReply(reply) {
  const authorLogin = reply?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && isAutomatedDiscussionCommentBody(reply?.body);
}

/**
 * Detect one top-level automated final-status comment.
 *
 * @param {any} comment Discussion comment payload.
 * @returns {boolean} True when the comment is the canonical conclusion root.
 */
function isAutomatedFinalDiscussionComment(comment) {
  const authorLogin = comment?.author?.login;

  return (authorLogin === "github-actions" || authorLogin === "github-actions[bot]")
    && typeof comment?.body === "string"
    && comment.body.trimStart().startsWith(DISCUSSION_FINAL_COMMENT_MARKER);
}

/**
 * Find the newest automated final-status root comment in one Discussion.
 *
 * @param {any[]} comments Discussion comments.
 * @returns {any | null} Latest automated final comment.
 */
function findLatestAutomatedFinalComment(comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return null;
  }

  return [...comments].reverse().find((comment) => isAutomatedFinalDiscussionComment(comment)) ?? null;
}

/**
 * Resolve the newest automated conclusion entry inside one final-comment thread.
 *
 * The root final comment stays as the canonical reply target, but later rounds
 * append newer automated final-status replies below that same root. Follow-up
 * blocker reconciliation must read the newest automated conclusion body rather
 * than the original root body from the first failing round.
 *
 * @param {{ body?: string, id?: string, createdAt?: string, publishedAt?: string, replies?: { nodes?: any[] } } | null} finalComment Final-status root comment.
 * @returns {{ body: string, id: string | null, createdAt: string }} Latest automated conclusion entry.
 */
function getLatestAutomatedConclusionEntry(finalComment) {
  if (!finalComment || typeof finalComment.body !== "string") {
    return {
      body: "",
      id: null,
      createdAt: "unknown time",
    };
  }

  const automatedEntries = [
    {
      body: finalComment.body,
      id: finalComment.id ?? null,
      createdAt: finalComment.publishedAt ?? finalComment.createdAt ?? "unknown time",
    },
    ...(finalComment.replies?.nodes ?? [])
      .filter((reply) => isAutomatedDiscussionReply(reply))
      .map((reply) => ({
        body: typeof reply?.body === "string" ? reply.body : "",
        id: reply?.id ?? null,
        createdAt: reply?.createdAt ?? "unknown time",
      })),
  ];

  return automatedEntries.at(-1) ?? {
    body: "",
    id: null,
    createdAt: "unknown time",
  };
}

/**
 * Extract a pull request number from one Discussion title/body string.
 *
 * @param {string} value Discussion title or body.
 * @returns {number | null} PR number when found.
 */
function extractPullRequestNumberFromText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(
    /<!--\s*ai-pr-discussion-pr-number\s*:\s*(\d+)\s*-->|(?:\[PR\s*#|Pull request origem:\s*#|Pull request origin:\s*#)\s*(\d+)|\/pull\/(\d+)(?:\b|[/?#])/i,
  );

  if (!match) {
    return null;
  }

  const number = Number.parseInt(match[1] ?? match[2] ?? match[3], 10);

  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Extract the linked pull request number from one Discussion payload.
 *
 * @param {{ title?: string, body?: string }} discussion Discussion payload.
 * @returns {number | null} Linked PR number when present.
 */
function extractPullRequestNumberFromDiscussion(discussion) {
  return extractPullRequestNumberFromText(discussion?.title)
    ?? extractPullRequestNumberFromText(discussion?.body);
}

/**
 * Build a bounded view of the latest conclusion thread.
 *
 * The previous automated conclusion plus the human replies below it are the
 * social contract for the next round. That thread tells the model what changed
 * since the last `Request changes` without feeding stale specialist memos back
 * in as if they were current facts.
 *
 * @param {any} finalComment Latest automated final-status root comment.
 * @returns {string} Bounded conclusion-thread context.
 */
function buildLatestConclusionThreadContext(finalComment) {
  if (!finalComment) {
    return "";
  }

  const latestAutomatedEntry = getLatestAutomatedConclusionEntry(finalComment);
  const humanReplies = getLatestHumanConclusionThreadReplies(finalComment.replies?.nodes ?? [])
    .filter((reply) => typeof reply?.body === "string" && reply.body.trim().length > 0)
    .map((reply) => [
      `#### reply by ${reply.author?.login ?? "unknown"} @ ${reply.createdAt ?? "unknown time"}`,
      truncateText(sanitizePublishedMarkdown(reply.body), MAX_DISCUSSION_CONTEXT_COMMENT_CHARS),
    ].join("\n"));

  if (!latestAutomatedEntry && humanReplies.length === 0) {
    return "";
  }

  return [
    "## Latest conclusion thread",
    "Treat this thread as the current round handoff. Human replies here are the author's response to the previous conclusion.",
    "",
    ...(latestAutomatedEntry
      ? [
        `### Previous automated conclusion @ ${latestAutomatedEntry.createdAt}`,
        truncateText(sanitizePublishedMarkdown(latestAutomatedEntry.body), MAX_DISCUSSION_CONTEXT_COMMENT_CHARS),
        "",
      ]
      : []),
    ...humanReplies,
  ].join("\n");
}

/**
 * Build a bounded, model-readable context block from prior Discussion comments.
 *
 * The review workflow is append-only by design, so the newest run must be able
 * to read prior operator updates and earlier automated findings. This context is
 * not treated as source code truth; it is operational history that prevents the
 * agents from asking again for evidence already posted in the Discussion.
 *
 * @param {Array<{ author?: { login?: string }, publishedAt?: string, body?: string }>} comments Discussion comments.
 * @returns {string} Bounded context block.
 */
export function buildDiscussionHistoryContext(comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return "";
  }

  const latestFinalComment = findLatestAutomatedFinalComment(comments);
  const sections = comments
    .filter((comment) => typeof comment?.body === "string" && comment.body.trim().length > 0)
    .filter((comment) => !isAutomatedDiscussionComment(comment))
    .map((comment) => {
      const author = comment.author?.login ?? "unknown";
      const publishedAt = comment.publishedAt ?? "unknown time";
      const body = truncateText(sanitizePublishedMarkdown(comment.body), MAX_DISCUSSION_CONTEXT_COMMENT_CHARS);

      return [
        `### ${publishedAt} by ${author}`,
        body,
      ].join("\n");
    });
  const conclusionThreadContext = buildLatestConclusionThreadContext(latestFinalComment);

  return truncateText(
    [...sections, ...(conclusionThreadContext ? [conclusionThreadContext] : [])].join("\n\n"),
    MAX_DISCUSSION_CONTEXT_CHARS,
  );
}

/**
 * Parse testable blockers from the latest final Discussion comment.
 *
 * This consumes the canonical `Acceptance tests requested` section introduced by
 * the review automation itself. Items outside that section are ignored.
 *
 * @param {string} finalCommentBody Latest automated final-status comment body.
 * @returns {Array<{
 *   roles: string[],
 *   suggestedTestFile: string,
 *   behaviorProtected: string,
 *   minimumScenario: string,
 *   essentialAssertions: string[],
 *   resolutionCondition: string
 * }>} Parsed testable blockers in display order.
 */
export function extractFollowUpTestableBlockers(finalCommentBody) {
  const sectionBody = extractMarkdownSectionBody(finalCommentBody, "Acceptance tests requested");

  if (sectionBody.length === 0) {
    return [];
  }

  return sectionBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .flatMap((line) => {
      const match = line.match(/^- Roles (.+?) -> `+([^`]+)`+: protect (.+?); minimum scenario: (.+?); essential assertions: (.+?); resolution condition: (.+?)\.?$/);

      if (!match) {
        return [];
      }

      const roles = [...match[1].matchAll(/`([^`]+)`/g)]
        .map((roleMatch) => roleMatch[1].trim())
        .filter((role) => role.length > 0);

      if (roles.length === 0) {
        return [];
      }

      return [{
        roles,
        suggestedTestFile: stripWrappingCodeMarkers(match[2]),
        behaviorProtected: summarizeBlockerFieldValue(match[3]),
        minimumScenario: summarizeBlockerFieldValue(match[4]),
        essentialAssertions: splitPipeJoinedSummaryValue(match[5]),
        resolutionCondition: summarizeBlockerFieldValue(match[6]),
      }];
    });
}

/**
 * Extract explicit test-file citations from human replies in the latest
 * conclusion thread.
 *
 * @param {Array<{ body?: string, author?: { login?: string } }>} replies Discussion reply payloads.
 * @returns {string[]} Unique cited test-file paths.
 */
export function extractConclusionThreadTestFileCitations(replies) {
  const citedPaths = [];

  for (const reply of getLatestHumanConclusionThreadReplies(replies)) {
    if (isAutomatedDiscussionReply(reply)) {
      continue;
    }

    const replyBody = typeof reply?.body === "string" ? reply.body : "";

    for (const match of replyBody.matchAll(TEST_FILE_REFERENCE_PATTERN)) {
      pushUniqueSummaryValue(citedPaths, stripWrappingCodeMarkers(match[1]));
    }
  }

  return citedPaths;
}

/**
 * Select only the latest human-authored handoff replies from one conclusion
 * thread.
 *
 * Root final comments stay append-only, so later rounds coexist in the same
 * reply list. The canonical current handoff is the contiguous human-authored
 * suffix that appears after the last automated reply in that thread.
 *
 * @param {Array<{ body?: string, author?: { login?: string } }>} replies Discussion reply payloads.
 * @returns {Array<any>} Latest human handoff replies in original order.
 */
function getLatestHumanConclusionThreadReplies(replies) {
  const allReplies = Array.isArray(replies) ? replies : [];
  const latestAutomatedReplyIndex = allReplies.findLastIndex((reply) => isAutomatedDiscussionReply(reply));
  const latestRoundReplies = latestAutomatedReplyIndex >= 0
    ? allReplies.slice(latestAutomatedReplyIndex + 1)
    : allReplies;

  return latestRoundReplies.filter((reply) => !isAutomatedDiscussionReply(reply));
}

/**
 * Collapse human conclusion-thread replies into one comparable evidence blob.
 *
 * Follow-up rounds often clear a blocker by explicitly citing the validation
 * scenario they ran on the current PR, even when the changed file itself is a
 * config file whose patch cannot contain the full runtime assertion text. The
 * reconciler still requires the suggested file (or an explicit equivalent) plus
 * green CI; this helper only lets the authored handoff text satisfy the
 * remaining evidence marker when it quotes the requested scenario or condition.
 *
 * @param {Array<{ body?: string, author?: { login?: string } }>} replies Discussion reply payloads.
 * @returns {string} Normalized human-authored evidence text.
 */
function extractConclusionThreadReplyEvidenceText(replies) {
  const replyBodies = getLatestHumanConclusionThreadReplies(replies)
    .map((reply) => (typeof reply?.body === "string" ? reply.body : ""))
    .filter((body) => body.trim().length > 0);

  return normalizeComparableText(replyBodies.join("\n"));
}

/**
 * Decide whether the current PR reports a green `CI / Test` status.
 *
 * @param {Array<any>} statusCheckContexts Pull-request status-check contexts.
 * @returns {boolean} True when the canonical CI test check is green.
 */
export function isCiTestCheckGreen(statusCheckContexts) {
  return (Array.isArray(statusCheckContexts) ? statusCheckContexts : []).some((context) => (
    context?.__typename === "CheckRun"
      ? context.name === "Test" && context.workflowName === "CI" && String(context.conclusion).toUpperCase() === "SUCCESS"
      : context?.__typename === "StatusContext"
        && context.context === "CI / Test"
        && String(context.state).toUpperCase() === "SUCCESS"
  ));
}

/**
 * Describe the canonical `CI / Test` check state for the current PR.
 *
 * @param {Array<any>} statusCheckContexts Pull-request status-check contexts.
 * @returns {{ found: boolean, completed: boolean, green: boolean }} Parsed CI state.
 */
export function getCiTestCheckState(statusCheckContexts) {
  const ciContext = (Array.isArray(statusCheckContexts) ? statusCheckContexts : []).find((context) => (
    context?.__typename === "CheckRun"
      ? context.name === "Test" && context.workflowName === "CI"
      : context?.__typename === "StatusContext"
        && context.context === "CI / Test"
  ));

  if (!ciContext) {
    return { found: false, completed: false, green: false };
  }

  if (ciContext.__typename === "CheckRun") {
    const conclusion = String(ciContext.conclusion ?? "").toUpperCase();
    const completed = String(ciContext.status ?? "").toUpperCase() === "COMPLETED" || conclusion.length > 0;

    return {
      found: true,
      completed,
      green: conclusion === "SUCCESS",
    };
  }

  const state = String(ciContext.state ?? "").toUpperCase();

  return {
    found: true,
    completed: state.length > 0 && !["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(state),
    green: state === "SUCCESS",
  };
}

/**
 * Decide whether a discussion-side rerun must wait for the canonical CI / Test
 * result instead of generating another blocking round from stale status data.
 *
 * @param {string} eventName GitHub event name.
 * @param {{ id?: string } | null} latestFinalComment Latest automated final comment.
 * @param {Array<any>} statusCheckContexts Current PR status contexts.
 * @returns {boolean} True when the rerun must defer until CI is green.
 */
export function shouldDeferDiscussionReviewUntilCiGreen(eventName, latestFinalComment, statusCheckContexts) {
  return eventName === "discussion_comment"
    && Boolean(latestFinalComment?.id)
    && !isCiTestCheckGreen(statusCheckContexts);
}

/**
 * Wait until the canonical `CI / Test` check reaches a terminal state.
 *
 * GitHub Actions cannot express `needs` across workflows, so the discussion
 * lane must poll the PR status rollup before it can safely reconcile blocker
 * contracts against the final CI result of the same head commit.
 *
 * @param {string} repository Repository in owner/name form.
 * @param {number} pullRequestNumber Pull request number.
 * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [options] Timing options.
 * @returns {Promise<{ found: boolean, completed: boolean, green: boolean }>} Final CI state.
 */
export async function waitForCiTestConclusion(
  repository,
  pullRequestNumber,
  options = {},
) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15 * 60 * 1000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 5000;
  const normalizedPollIntervalMs = Math.max(0, pollIntervalMs);
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(normalizedPollIntervalMs, 1)) + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const state = getCiTestCheckState(await fetchPullRequestStatusCheckRollup(repository, pullRequestNumber));

    if (state.completed) {
      return state;
    }

    if (Date.now() > deadline || attempt === maxAttempts - 1) {
      break;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, normalizedPollIntervalMs);
    });
  }

  throw new Error(`Timed out waiting for CI / Test on PR #${pullRequestNumber}.`);
}

/**
 * Build stable diff-evidence needles from one blocker field.
 *
 * Full fields stay in play, but code-ish fragments inside backticks also count
 * as explicit markers because specialist memos often reference assertions that
 * appear verbatim in the changed test body.
 *
 * @param {string} value Raw blocker field.
 * @returns {string[]} Unique comparison needles.
 */
function extractDiffEvidenceNeedles(value) {
  const needles = [];
  const normalizedValue = normalizeComparableText(value);

  if (normalizedValue.length > 0) {
    pushUniqueSummaryValue(needles, normalizedValue);
  }

  for (const match of String(value ?? "").matchAll(/`([^`]+)`/g)) {
    const fragment = normalizeComparableText(match[1]);

    if (fragment.length >= 3) {
      pushUniqueSummaryValue(needles, fragment);
    }

    for (const identifierMatch of match[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
      const identifier = identifierMatch[0];

      if (/[A-Z_$]/.test(identifier) || String(match[1]).includes("(")) {
        pushUniqueSummaryValue(needles, normalizeComparableText(identifier));
      }
    }
  }

  return needles;
}

function extractFollowUpEvidenceTerms(value) {
  const stopWords = new Set([
    "after",
    "again",
    "against",
    "before",
    "being",
    "current",
    "either",
    "explicit",
    "file",
    "from",
    "into",
    "must",
    "only",
    "path",
    "rule",
    "should",
    "that",
    "the",
    "then",
    "this",
    "when",
    "where",
    "with",
    "without",
    "workflow",
  ]);

  return [...new Set((normalizeComparableText(value).match(/[a-z0-9_$-]{4,}/g) ?? [])
    .map((term) => term.replace(/(?:ing|ed|s)$/u, ""))
    .filter((term) => term.length >= 4 && !stopWords.has(term)))];
}

function hasTermEvidenceForFollowUpBlocker(candidateText, blocker) {
  const terms = [
    ...extractFollowUpEvidenceTerms(blocker.behaviorProtected),
    ...extractFollowUpEvidenceTerms(blocker.minimumScenario),
    ...blocker.essentialAssertions.flatMap(extractFollowUpEvidenceTerms),
    ...extractFollowUpEvidenceTerms(blocker.resolutionCondition),
  ];
  const uniqueTerms = [...new Set(terms)];

  if (uniqueTerms.length === 0) {
    return false;
  }

  const matchedTerms = uniqueTerms.filter((term) => candidateText.includes(term));

  return matchedTerms.length >= Math.min(4, uniqueTerms.length);
}

/**
 * Check whether the authored conclusion-thread handoff quotes any canonical
 * validation marker for a blocker.
 *
 * @param {string} replyEvidenceText Normalized human-reply evidence corpus.
 * @param {{
 *   behaviorProtected: string,
 *   minimumScenario: string,
 *   essentialAssertions: string[],
 *   resolutionCondition: string
 * }} blocker Blocker being evaluated.
 * @returns {boolean} True when the reply text carries usable evidence.
 */
function hasReplyEvidenceForFollowUpBlocker(replyEvidenceText, blocker) {
  const evidenceNeedles = [
    ...blocker.essentialAssertions.flatMap(extractDiffEvidenceNeedles),
    ...extractDiffEvidenceNeedles(blocker.behaviorProtected),
    ...extractDiffEvidenceNeedles(blocker.minimumScenario),
    ...extractDiffEvidenceNeedles(blocker.resolutionCondition),
  ];

  return evidenceNeedles.some((needle) => replyEvidenceText.includes(normalizeComparableText(needle)));
}

/**
 * Reconcile previous testable blockers against the current PR diff, reply
 * thread, and CI status.
 *
 * @param {{ body?: string, replies?: { nodes?: any[] } }} finalComment Latest automated final-status comment.
 * @param {any[]} files Current PR files.
 * @param {Array<any>} statusCheckContexts Current PR status-check contexts.
 * @param {Record<string, string>} [repositoryFileContents] Optional current repository file contents keyed by path.
 * @returns {Array<{
 *   role: string,
 *   suggestedTestFile: string,
 *   behaviorProtected: string,
 *   minimumScenario: string,
 *   essentialAssertions: string[],
 *   resolutionCondition: string,
 *   matchedTestFile: string | null,
 *   missingSignals: string[]
 * }>} Unresolved testable blockers that must remain active.
 */
export function reconcileFollowUpTestableBlockers(finalComment, files, statusCheckContexts, repositoryFileContents = {}) {
  const latestConclusion = getLatestAutomatedConclusionEntry(finalComment);
  const previousBlockers = extractFollowUpTestableBlockers(latestConclusion.body);

  if (previousBlockers.length === 0) {
    return [];
  }

  const evidenceRecords = collectFollowUpEvidenceRecords(
    finalComment,
    files,
    statusCheckContexts,
    repositoryFileContents,
  );
  const evidenceByRole = new Map(evidenceRecords.map((record) => [record.role, record]));

  return previousBlockers.flatMap((blocker) => blocker.roles.flatMap((role) => {
    const evidence = evidenceByRole.get(role) ?? {
      matchedTestFile: null,
      hasPatchEvidence: false,
      hasRepositoryEvidence: false,
      hasReplyEvidence: false,
      ciTestGreen: false,
    };
    const missingSignals = [
      ...(evidence.matchedTestFile ? [] : ["suggested_test_file_or_explicit_equivalent"]),
      ...(evidence.hasPatchEvidence || evidence.hasRepositoryEvidence || evidence.hasReplyEvidence ? [] : ["essential_assertion_or_behavior_marker"]),
      ...(evidence.ciTestGreen ? [] : ["ci_test_green"]),
    ];

    if (missingSignals.length === 0) {
      return [];
    }

    return [{
      role,
      suggestedTestFile: blocker.suggestedTestFile,
      behaviorProtected: blocker.behaviorProtected,
      minimumScenario: blocker.minimumScenario,
      essentialAssertions: blocker.essentialAssertions,
      resolutionCondition: blocker.resolutionCondition,
      matchedTestFile: evidence.matchedTestFile,
      missingSignals,
    }];
  }));
}

/**
 * Build a deterministic blocking memo when a previous testable blocker is still
 * unresolved in the current follow-up round.
 *
 * @param {{
 *   role: string,
 *   suggestedTestFile: string,
 *   behaviorProtected: string,
 *   minimumScenario: string,
 *   essentialAssertions: string[],
 *   resolutionCondition: string,
 *   matchedTestFile: string | null,
 *   missingSignals: string[]
 * }} blocker Unresolved follow-up blocker.
 * @returns {string} Canonical request-changes memo.
 */
export function buildFollowUpBlockingMemo(blocker) {
  const missingSignalLabels = blocker.missingSignals.map((signal) => ({
    suggested_test_file_or_explicit_equivalent: "current diff does not include the suggested test file or an explicitly cited equivalent",
    essential_assertion_or_behavior_marker: "current diff does not show an essential assertion or behavior marker",
    ci_test_green: "`CI / Test` is not green on the current PR",
  }[signal] ?? signal));

  return [
    "## Perspective",
    "A previously-requested testable blocker from the latest conclusion thread is still unresolved in the current PR state.",
    "",
    "## Findings",
    `- Missing follow-up signals: ${missingSignalLabels.join("; ")}.`,
    `- The blocker cannot clear until the current PR changes \`${blocker.suggestedTestFile}\` or an explicitly cited equivalent, shows the required diff evidence, and has a green \`CI / Test\` check.`,
    "",
    "## Questions",
    "- None.",
    "",
    "## Merge posture",
    "Not ready yet. The previous testable blocker remains active under the follow-up reconciliation contract.",
    "",
    "## Blocker contract",
    "Testability: Testable",
    `Behavior protected: ${blocker.behaviorProtected}`,
    `Suggested test file: ${blocker.suggestedTestFile}`,
    `Minimum scenario: ${blocker.minimumScenario}`,
    `Essential assertions: ${blocker.essentialAssertions.join(" | ")}`,
    `Resolution rule: ${blocker.resolutionCondition}`,
    "Why this test resolves the blocker: the previous blocker only clears when the current PR shows the required diff evidence and a green CI / Test result.",
    "",
    "## Recommendation",
    "Request changes",
  ].join("\n");
}

/**
 * Build a deterministic synthesis when unresolved follow-up blockers remain.
 *
 * @param {Array<{
 *   role: string,
 *   suggestedTestFile: string,
 *   missingSignals: string[]
 * }>} blockers Unresolved follow-up blockers.
 * @returns {string} Canonical request-changes synthesis.
 */
function buildFollowUpBlockingSynthesis(blockers) {
  return [
    "Request changes",
    "",
    "## Findings",
    ...blockers.map((blocker) =>
      `- \`${blocker.role}\` still lacks the follow-up evidence required to clear \`${blocker.suggestedTestFile}\`: ${blocker.missingSignals.join(", ")}.`),
    "",
    "## Recommendation",
    "Request changes",
  ].join("\n");
}

/**
 * Apply deterministic follow-up blockers to one debate after the model run.
 *
 * @param {{ product: string, technical: string, risk: string, synthesis: string }} debate Model debate output.
 * @param {Array<{
 *   role: string,
 *   suggestedTestFile: string,
 *   behaviorProtected: string,
 *   minimumScenario: string,
 *   essentialAssertions: string[],
 *   resolutionCondition: string,
 *   matchedTestFile: string | null,
 *   missingSignals: string[]
 * }>} unresolvedBlockers Unresolved follow-up blockers.
 * @returns {{ product: string, technical: string, risk: string, synthesis: string }} Debate with deterministic blockers applied.
 */
export function applyFollowUpReconciliationToDebate(debate, unresolvedBlockers) {
  if (!Array.isArray(unresolvedBlockers) || unresolvedBlockers.length === 0) {
    return debate;
  }

  const nextDebate = { ...debate };

  for (const blocker of unresolvedBlockers) {
    nextDebate[blocker.role] = buildFollowUpBlockingMemo(blocker);
  }

  nextDebate.synthesis = augmentDiscussionSynthesis(
    buildFollowUpBlockingSynthesis(unresolvedBlockers),
    nextDebate,
  );

  return nextDebate;
}

/**
 * Resolve existing Discussion context for a PR before generating new memos.
 *
 * @param {string} repository Repository in owner/name form.
 * @param {number} pullRequestNumber PR number.
 * @returns {Promise<{ discussionUrl: string | null, context: string }>} Existing Discussion context.
 */
async function resolveExistingDiscussionContext(repository, pullRequestNumber) {
  const [owner, name] = repository.split("/");
  const [comments, repositoryMetadata] = await Promise.all([
    fetchPullRequestComments(repository, pullRequestNumber),
    fetchRepositoryDiscussionMetadata(owner, name),
  ]);
  const existingDiscussion = findExistingDiscussionTarget(
    pullRequestNumber,
    comments,
    repositoryMetadata.discussions.nodes,
  );

  if (!existingDiscussion?.id) {
    if (existingDiscussion?.number) {
      const recoveredDiscussion = await fetchDiscussionByNumber(owner, name, existingDiscussion.number);

      if (recoveredDiscussion?.id) {
        const discussionComments = await fetchDiscussionComments(recoveredDiscussion.id);

        return {
          discussionUrl: recoveredDiscussion.url,
          context: buildDiscussionHistoryContext(discussionComments),
        };
      }
    }

    return {
      discussionUrl: existingDiscussion?.url ?? null,
      context: "",
    };
  }

  const discussionComments = await fetchDiscussionComments(existingDiscussion.id);

  return {
    discussionUrl: existingDiscussion.url,
    context: buildDiscussionHistoryContext(discussionComments),
  };
}

/**
 * Resolve the pull request context for either pull_request or Discussion-side
 * reruns.
 *
 * Reply-driven reruns are anchored in the existing PR Discussion. The workflow
 * therefore supports both native pull_request events and human comments in the
 * linked Discussion thread.
 *
 * @param {string} repository Repository in owner/name form.
 * @param {any} event Raw GitHub event payload.
 * @returns {Promise<{ pullRequest: any, discussion: any | null } | null>} PR context or null when skipped.
 */
async function resolvePullRequestContext(repository, event) {
  if (event.pull_request) {
    return {
      pullRequest: event.pull_request,
      discussion: null,
    };
  }

  if (event.workflow_run) {
    if (!isCompletedCiWorkflowRunEvent(event)) {
      logOperationalEvent("ai_pr_review.skip", {
        reason: "unsupported_workflow_run",
        workflowName: event.workflow_run?.name ?? null,
        workflowStatus: event.workflow_run?.status ?? null,
      });
      return null;
    }

    const pullRequestNumber = extractPullRequestNumberFromWorkflowRunEvent(event);
    const pullRequest = await fetchPullRequest(repository, pullRequestNumber);

    if (pullRequest.state !== "open" || pullRequest.draft === true) {
      logOperationalEvent("ai_pr_review.skip", {
        reason: "pull_request_not_reviewable",
        pullRequestNumber,
        pullRequestState: pullRequest.state,
        draft: Boolean(pullRequest.draft),
      });
      return null;
    }

    const existingDiscussionContext = await resolveExistingDiscussionContext(repository, pullRequestNumber);

    return {
      pullRequest,
      discussion: existingDiscussionContext?.discussion ?? null,
    };
  }

  if (event.comment && event.discussion && isAutomationDiscussionCommentEvent(event)) {
    logOperationalEvent("ai_pr_review.skip", {
      reason: "bot_discussion_comment",
      discussionNumber: event.discussion.number,
    });
    return null;
  }

  if (!event.discussion?.number) {
    logOperationalEvent("ai_pr_review.skip", {
      reason: "unsupported_event",
    });
    return null;
  }

  const [owner, name] = repository.split("/");
  const discussion = await fetchDiscussionByNumber(owner, name, event.discussion.number);

  if (!discussion) {
    throw new Error(`Discussion #${event.discussion.number} could not be reloaded.`);
  }

  const pullRequestNumber = extractPullRequestNumberFromDiscussion(discussion);

  if (!pullRequestNumber) {
    logOperationalEvent("ai_pr_review.skip", {
      reason: "discussion_not_linked_to_pull_request",
      discussionNumber: discussion.number,
    });
    return null;
  }

  const pullRequest = await fetchPullRequest(repository, pullRequestNumber);

  if (pullRequest.state !== "open") {
    logOperationalEvent("ai_pr_review.skip", {
      reason: "pull_request_not_open",
      pullRequestNumber,
      discussionNumber: discussion.number,
    });
    return null;
  }

  return { pullRequest, discussion };
}

/**
 * Create a new GitHub Discussion.
 *
 * @param {string} repositoryId Repository GraphQL node id.
 * @param {string} categoryId Selected category id.
 * @param {string} title Discussion title.
 * @param {string} body Discussion body.
 * @returns {Promise<{ id: string, number: number, url: string }>} Created discussion metadata.
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
          number
          url
        }
      }
    }
  `;
  const data = await githubGraphqlRequest(mutation, { repositoryId, categoryId, title, body });
  const discussion = data?.createDiscussion?.discussion;

  if (!discussion?.url || !Number.isInteger(discussion?.number)) {
    throw new Error("GitHub GraphQL response did not include the created discussion URL.");
  }

  return discussion;
}

/**
 * Add one GitHub Discussion comment or one reply to an existing comment.
 *
 * @param {string} discussionId Discussion node id.
 * @param {string} body Markdown comment body.
 * @param {string | null} [replyToId] Existing Discussion comment id when publishing a reply.
 * @returns {Promise<{ id: string, url: string }>} Created comment metadata.
 */
async function addDiscussionComment(discussionId, body, replyToId = null) {
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
  const data = await githubGraphqlRequest(mutation, { discussionId, body, replyToId });
  const comment = data?.addDiscussionComment?.comment;

  if (!comment?.url) {
    throw new Error("GitHub GraphQL response did not include the created discussion comment URL.");
  }

  return comment;
}

/**
 * Close or reopen one Discussion so the GitHub UI reflects the current state.
 *
 * @param {string} discussionId Discussion node id.
 * @param {"Approve" | "Request changes"} recommendation Final recommendation.
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
 * Classify one changed file into a repository-specific review category.
 *
 * @param {string} filename GitHub file path.
 * @returns {"docs" | "tests" | "source" | "workflow" | "prompt" | "config" | "other"} File category.
 */
function classifyReviewFile(filename) {
  const normalizedPath = normalizeRepositoryPath(filename);

  if (normalizedPath.startsWith(".github/prompts/")) {
    return "prompt";
  }

  if (
    normalizedPath === "readme.md" ||
    normalizedPath.startsWith("docs/") ||
    normalizedPath.endsWith(".md")
  ) {
    return "docs";
  }

  if (
    normalizedPath.startsWith("test/") ||
    normalizedPath.includes("/__tests__/") ||
    normalizedPath.endsWith(".test.js") ||
    normalizedPath.endsWith(".spec.js")
  ) {
    return "tests";
  }

  if (normalizedPath.startsWith(".github/workflows/")) {
    return "workflow";
  }

  if (
    normalizedPath === "package.json" ||
    normalizedPath === "package-lock.json" ||
    normalizedPath === "wrangler.jsonc" ||
    normalizedPath.startsWith("migrations/") ||
    normalizedPath.startsWith("infra/")
  ) {
    return "config";
  }

  if (
    normalizedPath.startsWith("src/") ||
    normalizedPath.startsWith("scripts/")
  ) {
    return "source";
  }

  return "other";
}

/**
 * Return only the added/removed patch lines, excluding diff file headers.
 *
 * @param {any} file GitHub file payload.
 * @returns {string[]} Changed patch lines.
 */
function getChangedPatchLines(file) {
  if (typeof file?.patch !== "string") {
    return [];
  }

  return file.patch
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
    .map((line) => line.slice(1).trim());
}

/**
 * Decide whether a tiny workflow-only change can stay in the direct lane.
 *
 * Tiny CI tuning, such as changing a model default or a harmless env var, should
 * not create a heavyweight Discussion. Changes that expand permissions, touch
 * secrets, or alter event trust boundaries still require the deeper lane.
 *
 * @param {any[]} files Changed files from GitHub.
 * @param {ReturnType<typeof summarizePullRequestScope>} summary Scope summary.
 * @returns {boolean} True when direct review is enough.
 */
function isSmallNonSensitiveWorkflowChange(files, summary) {
  if (
    summary.categories.length !== 1 ||
    summary.categories[0] !== "workflow" ||
    summary.fileCount > DIRECT_REVIEW_MAX_WORKFLOW_FILES ||
    summary.totalChangedLines > DIRECT_REVIEW_MAX_WORKFLOW_LINES
  ) {
    return false;
  }

  const changedLines = files.flatMap(getChangedPatchLines);

  if (changedLines.length === 0) {
    return false;
  }

  const executableAutomationLines = files
    .filter((file) => {
      const normalizedPath = normalizeRepositoryPath(file.filename);

      return normalizedPath === ".github/workflows/ai-pr-review.yml" || normalizedPath === "scripts/ai-pr-review.mjs";
    })
    .flatMap(getChangedPatchLines);

  return !executableAutomationLines.some((line) =>
    SENSITIVE_WORKFLOW_CHANGE_PATTERNS.some((pattern) => pattern.test(line)),
  );
}

/**
 * Decide whether a bounded change to the review automation policy can stay in
 * direct review.
 *
 * This covers edits like tuning the classifier itself, adding focused tests for
 * the route decision, or documenting the policy. It deliberately stays narrow:
 * broad rewrites, permission expansion, secret handling, and unrelated source
 * changes still go to Discussion.
 *
 * @param {any[]} files Changed files from GitHub.
 * @param {ReturnType<typeof summarizePullRequestScope>} summary Scope summary.
 * @returns {boolean} True when the direct lane is enough.
 */
function isSmallReviewAutomationPolicyChange(files, summary) {
  if (
    summary.fileCount > DIRECT_REVIEW_MAX_AUTOMATION_POLICY_FILES ||
    summary.totalChangedLines > DIRECT_REVIEW_MAX_AUTOMATION_POLICY_LINES
  ) {
    return false;
  }

  const allowedPaths = new Set(
    [
      ".github/workflows/ai-pr-review.yml",
      ".github/prompts/ai-pr-discussion-product.md",
      ".github/prompts/ai-pr-discussion-technical.md",
      ".github/prompts/ai-pr-discussion-risk.md",
      ".github/prompts/ai-pr-discussion-synthesis.md",
      "scripts/ai-pr-review.mjs",
      "test/ai-pr-review.test.js",
      "docs/wiki/Contribuicao-e-PRs.md",
    ].map(normalizeRepositoryPath),
  );
  const allFilesAreReviewPolicyFiles = files.every((file) => allowedPaths.has(normalizeRepositoryPath(file.filename)));

  if (!allFilesAreReviewPolicyFiles) {
    return false;
  }

  const changedLines = files.flatMap(getChangedPatchLines);

  if (changedLines.length === 0) {
    return false;
  }

  const executableAutomationLines = files
    .filter((file) => {
      const normalizedPath = normalizeRepositoryPath(file.filename);

      return normalizedPath === ".github/workflows/ai-pr-review.yml" || normalizedPath === "scripts/ai-pr-review.mjs";
    })
    .flatMap(getChangedPatchLines);

  return !executableAutomationLines.some((line) =>
    SENSITIVE_WORKFLOW_CHANGE_PATTERNS.some((pattern) => pattern.test(line)),
  );
}

/**
 * Sort files so the model sees executable behavior and tests before prose.
 *
 * GitHub returns PR files in path order. For broad PRs, that can spend most of
 * the context window on docs and hide the source/test files that prove whether
 * an older concern is still true. Review payload ordering must favor current
 * behavioral evidence over repository path order.
 *
 * @param {any[]} files Changed files from GitHub.
 * @returns {any[]} Files ordered for model review.
 */
export function sortFilesForReview(files) {
  return sortFilesForReviewWithPriorityPaths(files, []);
}

/**
 * Sort files so the model sees explicit follow-up evidence before incidental
 * files from the same category.
 *
 * @param {any[]} files Changed files from GitHub.
 * @param {string[]} prioritizedPaths Repository-relative paths that must stay visible.
 * @returns {any[]} Files ordered for model review.
 */
function sortFilesForReviewWithPriorityPaths(files, prioritizedPaths = []) {
  const prioritizedPathSet = new Set(
    (Array.isArray(prioritizedPaths) ? prioritizedPaths : [])
      .map((path) => normalizeRepositoryPath(path))
      .filter((path) => path.length > 0),
  );

  return [...files].sort((left, right) => {
    const priorityDelta = getFileReviewPriority(right, prioritizedPathSet) - getFileReviewPriority(left, prioritizedPathSet);

    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return String(left.filename).localeCompare(String(right.filename));
  });
}

/**
 * Rank a changed file by how much current behavioral evidence it can provide.
 *
 * Broad operational PRs can have many docs and support files. The model must
 * see the current auth, persistence, health, and request-level tests before it
 * reasons from older Discussion comments. This score is still deterministic and
 * bounded; it only changes ordering inside the already-capped review payload.
 *
 * @param {any} file GitHub changed-file payload.
 * @param {Set<string>} [prioritizedPaths] Explicit paths that must stay visible in follow-up rounds.
 * @returns {number} Review priority score.
 */
function getFileReviewPriority(file, prioritizedPaths = new Set()) {
  const normalizedPath = normalizeRepositoryPath(file?.filename);
  const category = classifyReviewFile(normalizedPath);
  const categoryPriority = REVIEW_FILE_PRIORITY_BY_CATEGORY[category] ?? REVIEW_FILE_PRIORITY_BY_CATEGORY.other;
  const criticalPathBoost = isCriticalReviewFile(file) ? 30 : 0;
  const explicitFollowUpBoost = prioritizedPaths.has(normalizedPath) ? 40 : 0;

  return categoryPriority + criticalPathBoost + explicitFollowUpBoost;
}

/**
 * Identify files whose diffs carry merge-critical operational evidence.
 *
 * These files own auth, persistence, health readiness, and request-level
 * regression tests. They still compete inside the same bounded prompt, but each
 * receives a larger per-file patch budget so a reviewer does not see the file
 * name while missing the behavior that proves the current PR state.
 *
 * @param {any} file GitHub changed-file payload.
 * @returns {boolean} True when the file should use the critical patch budget.
 */
function isCriticalReviewFile(file) {
  const normalizedPath = normalizeRepositoryPath(file?.filename);

  return REVIEW_CRITICAL_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

/**
 * Summarize the scope of the PR so the merge gate can stay deterministic.
 *
 * @param {any[]} files Changed files from GitHub.
 * @returns {{
 *   fileCount: number,
 *   totalChangedLines: number,
 *   topLevelAreaCount: number,
 *   areas: string[],
 *   categories: string[],
 *   highestSignal: number,
 *   onlyDocsAndTests: boolean,
 * }} Stable scope summary.
 */
export function summarizePullRequestScope(files) {
  const categories = new Set();
  const areas = new Set();
  let totalChangedLines = 0;
  let highestSignal = 0;

  for (const file of files) {
    const normalizedPath = normalizeRepositoryPath(file.filename);
    const category = classifyReviewFile(file.filename);
    const topLevelArea = normalizedPath.includes("/") ? normalizedPath.split("/")[0] : "(root)";
    const additions = typeof file.additions === "number" ? file.additions : 0;
    const deletions = typeof file.deletions === "number" ? file.deletions : 0;

    categories.add(category);
    areas.add(topLevelArea);
    totalChangedLines += additions + deletions;
    highestSignal = Math.max(highestSignal, REVIEW_SIGNAL_BY_CATEGORY[category] ?? REVIEW_SIGNAL_BY_CATEGORY.other);
  }

  const categoryList = [...categories].sort();

  return {
    fileCount: files.length,
    totalChangedLines,
    topLevelAreaCount: areas.size,
    areas: [...areas].sort(),
    categories: categoryList,
    highestSignal,
    onlyDocsAndTests: categoryList.length > 0 && categoryList.every((category) => category === "docs" || category === "tests"),
  };
}

/**
 * Decide whether the PR must be routed into Discussion before merge.
 *
 * @param {any[]} files Changed files from GitHub.
 * @returns {{
 *   route: "direct_review" | "discussion_before_merge",
 *   requiresDiscussion: boolean,
 *   reason: string,
 *   summary: ReturnType<typeof summarizePullRequestScope>,
 * }} Gate decision.
 */
export function assessDiscussionGate(files) {
  const summary = summarizePullRequestScope(files);
  const isSmallLowRiskChange =
    summary.onlyDocsAndTests &&
    summary.fileCount <= DIRECT_REVIEW_MAX_FILES &&
    summary.totalChangedLines <= DIRECT_REVIEW_MAX_TOTAL_LINES &&
    summary.topLevelAreaCount <= DIRECT_REVIEW_MAX_AREAS;

  if (isSmallLowRiskChange) {
    const decision = {
      route: DISCUSSION_ROUTE_DIRECT,
      requiresDiscussion: false,
      reason: `Small low-risk PR limited to docs/tests (${summary.fileCount} files, ${summary.totalChangedLines} changed lines).`,
      summary,
    };

    logOperationalEvent("ai_pr_review.gate_decision", {
      route: decision.route,
      requiresDiscussion: decision.requiresDiscussion,
      reason: decision.reason,
    });

    return decision;
  }

  if (isSmallNonSensitiveWorkflowChange(files, summary)) {
    const decision = {
      route: DISCUSSION_ROUTE_DIRECT,
      requiresDiscussion: false,
      reason: `Small non-sensitive workflow PR (${summary.fileCount} files, ${summary.totalChangedLines} changed lines).`,
      summary,
    };

    logOperationalEvent("ai_pr_review.gate_decision", {
      route: decision.route,
      requiresDiscussion: decision.requiresDiscussion,
      reason: decision.reason,
    });

    return decision;
  }

  if (isSmallReviewAutomationPolicyChange(files, summary)) {
    const decision = {
      route: DISCUSSION_ROUTE_DIRECT,
      requiresDiscussion: false,
      reason: `Small non-sensitive review automation policy PR (${summary.fileCount} files, ${summary.totalChangedLines} changed lines).`,
      summary,
    };

    logOperationalEvent("ai_pr_review.gate_decision", {
      route: decision.route,
      requiresDiscussion: decision.requiresDiscussion,
      reason: decision.reason,
    });

    return decision;
  }

  const decision = {
    route: DISCUSSION_ROUTE_REQUIRED,
    requiresDiscussion: true,
    reason: `Meaningful PR scope detected (${summary.fileCount} files, ${summary.totalChangedLines} changed lines, categories: ${summary.categories.join(", ")}). Route into Discussion before merge.`,
    summary,
  };

  logOperationalEvent("ai_pr_review.gate_decision", {
    route: decision.route,
    requiresDiscussion: decision.requiresDiscussion,
    reason: decision.reason,
  });

  return decision;
}

/**
 * Build a stable human-readable digest of changed files for the model.
 *
 * @param {any[]} files Changed files from GitHub.
 * @returns {string} Compact file digest.
 */
function buildChangedFilesDigest(files, prioritizedPaths = []) {
  const orderedFiles = sortFilesForReviewWithPriorityPaths(files, prioritizedPaths);
  const selectedFiles = orderedFiles.slice(0, MAX_FILES);
  const digestLines = selectedFiles
    .map((file) => `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`)
    .join("\n");

  if (orderedFiles.length <= MAX_FILES) {
    return digestLines;
  }

  return [
    digestLines,
    `- Additional files omitted from digest: ${orderedFiles.length - MAX_FILES} lower-priority file(s).`,
  ].join("\n");
}

/**
 * Turn GitHub's file payload into a bounded review bundle for the model.
 *
 * @param {any[]} files Changed files from GitHub.
 * @returns {string} Compact diff payload.
 */
function buildFilesReviewPayload(files, prioritizedPaths = []) {
  const orderedFiles = sortFilesForReviewWithPriorityPaths(files, prioritizedPaths);
  const selectedFiles = orderedFiles.slice(0, MAX_FILES);
  const sections = selectedFiles.map((file) => {
    const patchLimit = isCriticalReviewFile(file) ? MAX_CRITICAL_PATCH_CHARS_PER_FILE : MAX_PATCH_CHARS_PER_FILE;
    const patch = truncateText(file.patch ?? "[no patch available]", patchLimit);

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

  if (orderedFiles.length > MAX_FILES) {
    sections.push(`### Additional files omitted\nOnly the top ${MAX_FILES} review-priority files were sent to the model.`);
  }

  return truncateText(sections.join("\n\n"), MAX_REVIEW_INPUT_CHARS);
}

/**
 * Extract the repository paths that the previous conclusion thread explicitly
 * requires in the next round.
 *
 * @param {{ body?: string, replies?: { nodes?: any[] } } | null} finalComment Latest automated final-status comment.
 * @returns {string[]} Unique repository-relative paths.
 */
export function extractFollowUpPriorityPaths(finalComment) {
  const latestConclusion = getLatestAutomatedConclusionEntry(finalComment);
  const previousBlockers = extractFollowUpTestableBlockers(latestConclusion.body);
  const explicitTestFileCitations = extractConclusionThreadTestFileCitations(finalComment?.replies?.nodes ?? []);

  return [...new Set([
    ...previousBlockers.map((blocker) => blocker.suggestedTestFile),
    ...explicitTestFileCitations,
  ].map((path) => normalizeRepositoryPath(path)).filter((path) => path.length > 0))];
}

/**
 * Compute deterministic follow-up evidence from the current PR plus the latest
 * conclusion-thread blocker contract.
 *
 * @param {{ body?: string, replies?: { nodes?: any[] } } | null} finalComment Latest automated final-status comment.
 * @param {any[]} files Current PR files.
 * @param {Array<any>} statusCheckContexts Current PR status-check contexts.
 * @param {Record<string, string>} [repositoryFileContents] Optional current repository file contents keyed by path.
 * @returns {Array<{
 *   role: string,
 *   suggestedTestFile: string,
 *   matchedTestFile: string | null,
 *   hasPatchEvidence: boolean,
 *   hasRepositoryEvidence: boolean,
 *   hasReplyEvidence: boolean,
 *   ciTestGreen: boolean,
 *   status: "resolved" | "missing_test_file" | "missing_behavior_evidence" | "waiting_for_ci"
 * }>} Stable evidence rows.
 */
export function collectFollowUpEvidenceRecords(
  finalComment,
  files,
  statusCheckContexts,
  repositoryFileContents = {},
) {
  const latestConclusion = getLatestAutomatedConclusionEntry(finalComment);
  const previousBlockers = extractFollowUpTestableBlockers(latestConclusion.body);

  if (previousBlockers.length === 0) {
    return [];
  }

  const explicitTestFileCitations = extractConclusionThreadTestFileCitations(finalComment?.replies?.nodes ?? []);
  const replyEvidenceText = extractConclusionThreadReplyEvidenceText(finalComment?.replies?.nodes ?? []);
  const ciTestGreen = isCiTestCheckGreen(statusCheckContexts);
  const normalizedRepositoryFileContents = Object.fromEntries(
    Object.entries(repositoryFileContents).map(([path, content]) => [normalizeRepositoryPath(path), String(content ?? "")]),
  );

  return previousBlockers.flatMap((blocker) => blocker.roles.map((role) => {
    const candidatePaths = [
      blocker.suggestedTestFile,
      ...explicitTestFileCitations,
    ].map((path) => normalizeRepositoryPath(path)).filter((path) => path.length > 0);
    const candidateFiles = files.filter((file) => candidatePaths.includes(normalizeRepositoryPath(file.filename)));
    const matchedTestFile = candidateFiles[0]?.filename ?? null;
    const candidatePatchText = normalizeComparableText(candidateFiles.flatMap(getChangedPatchLines).join("\n"));
    const candidateRepositoryText = normalizeComparableText(
      candidateFiles
        .map((file) => normalizedRepositoryFileContents[normalizeRepositoryPath(file.filename)] ?? "")
        .join("\n"),
    );
    const evidenceNeedles = [
      ...blocker.essentialAssertions.flatMap(extractDiffEvidenceNeedles),
      ...extractDiffEvidenceNeedles(blocker.behaviorProtected),
      ...extractDiffEvidenceNeedles(blocker.minimumScenario),
      ...extractDiffEvidenceNeedles(blocker.resolutionCondition),
    ];
    const hasPatchEvidence = evidenceNeedles.some((needle) => candidatePatchText.includes(needle));
    const hasRepositoryEvidence = evidenceNeedles.some((needle) => candidateRepositoryText.includes(needle))
      || hasTermEvidenceForFollowUpBlocker(candidateRepositoryText, blocker);
    const hasReplyEvidence = hasReplyEvidenceForFollowUpBlocker(replyEvidenceText, blocker);
    const status = !matchedTestFile
      ? "missing_test_file"
      : !(hasPatchEvidence || hasRepositoryEvidence || hasReplyEvidence)
        ? "missing_behavior_evidence"
        : !ciTestGreen
          ? "waiting_for_ci"
          : "resolved";

    return {
      role,
      suggestedTestFile: blocker.suggestedTestFile,
      matchedTestFile,
      hasPatchEvidence,
      hasRepositoryEvidence,
      hasReplyEvidence,
      ciTestGreen,
      status,
    };
  }));
}

/**
 * Render one deterministic follow-up evidence block for the model.
 *
 * @param {ReturnType<typeof collectFollowUpEvidenceRecords>} records Stable evidence rows.
 * @returns {string} Markdown context block.
 */
export function buildFollowUpEvidenceContext(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return "";
  }

  const lines = records.map((record) => (
    `- \`${record.role}\` -> \`${record.suggestedTestFile}\` | matched file: \`${record.matchedTestFile ?? "none"}\` | patch evidence: \`${String(record.hasPatchEvidence)}\` | repository evidence: \`${String(record.hasRepositoryEvidence)}\` | reply evidence: \`${String(record.hasReplyEvidence)}\` | CI / Test green: \`${String(record.ciTestGreen)}\` | status: \`${record.status}\``
  ));

  return [
    "## Follow-up blocker evidence",
    "These signals are computed deterministically from the latest conclusion thread, the current changed files, the checked-out head commit, and the canonical `CI / Test` result.",
    "Do not keep a prior acceptance-test blocker active when its status is `resolved` unless the current payload introduces a new contradictory regression.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Check whether the current PR touches one repository path.
 *
 * @param {any[]} files Changed files from GitHub.
 * @param {string} filename Repository-relative file path.
 * @returns {boolean} True when the path is part of the current PR.
 */
function hasChangedFile(files, filename) {
  const normalizedTarget = normalizeRepositoryPath(filename);

  return files.some((file) => normalizeRepositoryPath(file?.filename) === normalizedTarget);
}

/**
 * Prove the visible PR discussion-review job gates specialist execution on CI.
 *
 * The job itself must remain visible on the pull_request check list, but the
 * specialist step may only appear after the explicit await_ci step.
 *
 * @param {string} prReviewWorkflow Current workflow YAML.
 * @returns {boolean} True when the visible PR path has the CI gate in order.
 */
export function workflowHasVisibleDiscussionReviewCiGate(prReviewWorkflow) {
  const pullRequestIndex = prReviewWorkflow.indexOf("pull_request:");
  const discussionReviewIndex = prReviewWorkflow.indexOf("discussion-review:");
  const awaitCiModeIndex = prReviewWorkflow.indexOf("AI_PR_REVIEW_MODE: await_ci");
  const discussionModeIndex = prReviewWorkflow.indexOf("AI_PR_REVIEW_MODE: discussion");

  return pullRequestIndex >= 0
    && discussionReviewIndex > pullRequestIndex
    && awaitCiModeIndex > discussionReviewIndex
    && discussionModeIndex > awaitCiModeIndex;
}

/**
 * Prove Discussion-triggered reruns execute against the linked PR head.
 *
 * `discussion_comment` events are anchored on the default branch by GitHub.
 * The workflow must resolve the PR from the Discussion marker before checkout,
 * otherwise follow-up rounds evaluate stale `main` code instead of the PR diff.
 *
 * @param {string} prReviewWorkflow Current workflow YAML.
 * @returns {boolean} True when Discussion reruns checkout the linked PR SHA.
 */
export function workflowChecksOutDiscussionPullRequestHead(prReviewWorkflow) {
  const discussionCommentIndex = prReviewWorkflow.indexOf("discussion_comment:");
  const resolverIndex = prReviewWorkflow.indexOf("Resolve discussion pull request head");
  const missingPullRequestGuardIndex = prReviewWorkflow.indexOf("Could not resolve the linked pull request");
  const resolverFailureIndex = prReviewWorkflow.indexOf("exit 1", missingPullRequestGuardIndex);
  const canonicalMarkerParserIndex = prReviewWorkflow.indexOf("ai-pr-discussion-pr-number", resolverIndex);
  const originParserIndex = prReviewWorkflow.indexOf("Pull request origem", resolverIndex);
  const pullUrlParserIndex = Math.max(
    prReviewWorkflow.indexOf("/pull/", resolverIndex),
    prReviewWorkflow.indexOf("\\/pull\\/", resolverIndex),
  );
  const pullRequestApiIndex = prReviewWorkflow.indexOf('gh api "repos/${REPOSITORY}/pulls/${pr_number}"');
  const discussionCheckoutIndex = prReviewWorkflow.indexOf("Checkout discussion pull request head", pullRequestApiIndex);
  const discussionOnlyRefIndex = prReviewWorkflow.indexOf("ref: ${{ steps.discussion-pr-head.outputs.sha }}", discussionCheckoutIndex);
  const unsafePullRequestFallbackIndex = prReviewWorkflow.indexOf("steps.discussion-pr-head.outputs.sha || github.event.pull_request.head.sha", discussionCheckoutIndex);
  const unsafeGithubShaFallbackIndex = prReviewWorkflow.indexOf("|| github.sha", discussionCheckoutIndex);

  return discussionCommentIndex >= 0
    && resolverIndex > discussionCommentIndex
    && missingPullRequestGuardIndex > resolverIndex
    && resolverFailureIndex > missingPullRequestGuardIndex
    && canonicalMarkerParserIndex > resolverIndex
    && originParserIndex > resolverIndex
    && pullUrlParserIndex > resolverIndex
    && pullRequestApiIndex > resolverIndex
    && discussionCheckoutIndex > pullRequestApiIndex
    && discussionOnlyRefIndex > discussionCheckoutIndex
    && unsafePullRequestFallbackIndex < 0
    && unsafeGithubShaFallbackIndex < 0;
}

/**
 * Build a concise evidence block for automation-contract PRs.
 *
 * Broad automation PRs can leave the model staring at a large diff without the
 * one or two facts that prove the contract is wired end to end. This summary
 * reads the current checked-out repository state and surfaces the exact
 * workflow/script/test facts reviewers keep asking for.
 *
 * @param {{
 *   files: any[],
 *   prReviewWorkflow?: string,
 *   planningWorkflow?: string,
 *   prReviewScript?: string,
 *   planningScript?: string,
 *   triageScript?: string,
 *   prReviewTests?: string,
 *   planningTests?: string,
 *   triageTests?: string,
 * }} inputs Current repository evidence inputs.
 * @returns {string} Markdown summary, or an empty string when nothing relevant changed.
 */
export function buildAutomationEvidenceContext(inputs) {
  const {
    files,
    prReviewWorkflow = "",
    planningWorkflow = "",
    prReviewScript = "",
    planningScript = "",
    triageScript = "",
    prReviewTests = "",
    planningTests = "",
    triageTests = "",
  } = inputs;
  const bullets = [];

  if (
    hasChangedFile(files, ".github/workflows/ai-pr-review.yml")
    && workflowHasVisibleDiscussionReviewCiGate(prReviewWorkflow)
    && prReviewWorkflow.includes("discussion_comment:")
    && prReviewWorkflow.includes("ai-pr-review-${{ github.event_name }}")
    && prReviewWorkflow.includes("discussions: write")
    && workflowChecksOutDiscussionPullRequestHead(prReviewWorkflow)
  ) {
    bullets.push(
      "- Current PR review workflow state: `pull_request` keeps the visible PR checks, the visible `discussion-review` job runs `AI_PR_REVIEW_MODE=await_ci` before `AI_PR_REVIEW_MODE=discussion`, event-scoped concurrency prevents stale runs from canceling visible PR checks, and `discussion_comment` reruns resolve the linked PR head SHA before checkout while the job still requests `discussions: write`.",
    );
  }

  if (
    hasChangedFile(files, "scripts/ai-pr-review.mjs")
    && prReviewScript.includes("resolvePullRequestContext")
    && prReviewScript.includes("replyToId")
    && prReviewScript.includes("buildDiscussionHistoryContext")
  ) {
    bullets.push(
      "- Current PR review runtime state: discussion-side reruns resolve the linked PR, read the latest conclusion thread as handoff, and publish follow-up final status as a Discussion reply.",
    );
  }

  if (
    hasChangedFile(files, ".github/workflows/ai-issue-planning-review.yml")
    && planningWorkflow.includes("planning_status")
    && planningWorkflow.includes("blocking_roles")
    && planningWorkflow.includes("blocked_by_dependencies")
    && planningWorkflow.includes("$GITHUB_STEP_SUMMARY")
  ) {
    bullets.push(
      "- Current planning workflow state: `planning_status`, `blocking_roles`, and `blocked_by_dependencies` are exposed as step outputs and mirrored into `$GITHUB_STEP_SUMMARY` for visible operator consumption.",
    );
  }

  if (
    hasChangedFile(files, "scripts/ai-issue-planning-review.mjs")
    && planningScript.includes("\"Blocked\"")
    && planningScript.includes("writeGitHubOutput(\"planning_status\"")
    && planningScript.includes("blocked_by_dependencies")
  ) {
    bullets.push(
      "- Current planning runtime state: `Blocked` is a first-class planning outcome, exported through workflow outputs, and kept separate from the binary PR-review gate.",
    );
  }

  if (
    hasChangedFile(files, "scripts/ai-issue-triage.mjs")
    && triageScript.includes("executionReadiness")
    && triageScript.includes("needsDiscussion")
  ) {
    bullets.push(
      "- Current issue triage state: routing now validates `executionReadiness` and `needsDiscussion`, so `impact` is descriptive and no longer the only route decision input.",
    );
  }

  if (
    hasChangedFile(files, "test/ai-pr-review.test.js")
    && prReviewTests.includes("keeps Blocked planning-only by rejecting it in PR review recommendations")
    && prReviewTests.includes("pins the visible pull_request discussion-review check and CI await step before specialists")
    && prReviewTests.includes("repairs malformed blocking specialist memos before publishing synthetic blockers")
  ) {
    bullets.push(
      "- Current PR review regression tests: `test/ai-pr-review.test.js` explicitly pins the visible `pull_request` discussion-review path, the `await_ci` step before specialist execution, malformed blocker repair, and the guard that rejects `Blocked` inside PR review recommendations.",
    );
  }

  if (
    hasChangedFile(files, "test/ai-issue-planning-review.test.js")
    && planningTests.includes("pins planning workflow outputs in the operator summary")
  ) {
    bullets.push(
      "- Current planning regression tests: `test/ai-issue-planning-review.test.js` pins the workflow summary outputs so the new planning state contract stays visible and consumed.",
    );
  }

  if (
    hasChangedFile(files, "test/ai-issue-triage.test.js")
    && triageTests.includes("still allows medium-impact issues to route directly when execution is already clear")
    && triageTests.includes("still sends low-impact but ambiguous issues into discussion before PR")
  ) {
    bullets.push(
      "- Current triage regression tests: `test/ai-issue-triage.test.js` explicitly covers `medio -> direct_pr` and `baixo -> discussion_before_pr` so the relaxed route policy stays intentional.",
    );
  }

  if (bullets.length === 0) {
    return "";
  }

  return truncateText([
    "## Automation contract evidence",
    "Use these repository-state facts when deciding whether older automation blockers are still true.",
    "",
    ...bullets,
  ].join("\n"), 6000);
}

/**
 * Read the current checked-out repository files that prove automation state.
 *
 * The PR review runs inside a checkout of the head commit, so it can inspect
 * the exact workflow/script/test content that GitHub's changed-files API may
 * truncate or omit from the diff patch.
 *
 * @param {any[]} files Changed files from GitHub.
 * @returns {Promise<string>} Markdown evidence block for the review payload.
 */
async function loadAutomationEvidenceContext(files) {
  const wantedFiles = [
    ".github/workflows/ai-pr-review.yml",
    ".github/workflows/ai-issue-planning-review.yml",
    "scripts/ai-pr-review.mjs",
    "scripts/ai-issue-planning-review.mjs",
    "scripts/ai-issue-triage.mjs",
    "test/ai-pr-review.test.js",
    "test/ai-issue-planning-review.test.js",
    "test/ai-issue-triage.test.js",
  ].filter((filename) => hasChangedFile(files, filename));
  const uniqueFiles = [...new Set(wantedFiles)];
  const fileEntries = await Promise.all(uniqueFiles.map(async (filename) => {
    try {
      return [filename, await fs.readFile(filename, "utf8")];
    } catch {
      return [filename, ""];
    }
  }));
  const fileMap = Object.fromEntries(fileEntries);

  return buildAutomationEvidenceContext({
    files,
    prReviewWorkflow: fileMap[".github/workflows/ai-pr-review.yml"],
    planningWorkflow: fileMap[".github/workflows/ai-issue-planning-review.yml"],
    prReviewScript: fileMap["scripts/ai-pr-review.mjs"],
    planningScript: fileMap["scripts/ai-issue-planning-review.mjs"],
    triageScript: fileMap["scripts/ai-issue-triage.mjs"],
    prReviewTests: fileMap["test/ai-pr-review.test.js"],
    planningTests: fileMap["test/ai-issue-planning-review.test.js"],
    triageTests: fileMap["test/ai-issue-triage.test.js"],
  });
}

/**
 * Build the shared user payload that every reviewer role receives.
 *
 * @param {string} repository Repository in owner/name form.
 * @param {any} pullRequest GitHub pull request payload.
 * @param {any[]} files Changed files from GitHub.
 * @param {ReturnType<typeof assessDiscussionGate>} gate Gate decision.
 * @param {string} [discussionContext] Prior Discussion context for append-only reruns.
 * @param {string} [automationEvidence] Current repository-state evidence for automation contract changes.
 * @param {string} [failureLogContext] Real failed GitHub Actions logs for the current PR head.
 * @param {string} [followUpEvidenceContext] Deterministic evidence for prior acceptance-test blockers.
 * @param {string[]} [prioritizedPaths] Repository paths that must stay visible in bounded changed-file sections.
 * @returns {string} Final user payload.
 */
export function buildPullRequestUserPrompt(
  repository,
  pullRequest,
  files,
  gate,
  discussionContext = "",
  automationEvidence = "",
  failureLogContext = "",
  followUpEvidenceContext = "",
  prioritizedPaths = [],
) {
  const boundedDiscussionContext = discussionContext.trim()
    ? [
      "## Existing Discussion context",
      "These comments are append-only operational history from the linked Discussion. Use them to understand what was already answered, but treat the current changed-files payload as the technical source of truth.",
      "",
      discussionContext.trim(),
      "",
    ]
    : [];

  return truncateText([
    `Repository: ${repository}`,
    `PR: #${pullRequest.number} - ${pullRequest.title}`,
    `PR URL: ${pullRequest.html_url}`,
    `Base branch: ${pullRequest.base.ref}`,
    `Head branch: ${pullRequest.head.ref}`,
    "",
    "## Discussion gate",
    `Route: ${gate.route}`,
    `Reason: ${gate.reason}`,
    `Changed files: ${gate.summary.fileCount}`,
    `Changed lines: ${gate.summary.totalChangedLines}`,
    `Top-level areas: ${gate.summary.areas.join(", ") || "(none)"}`,
    `Categories: ${gate.summary.categories.join(", ") || "(none)"}`,
    "",
    "## PR description",
    truncateText(pullRequest.body ?? "", MAX_PR_BODY_CHARS) || "[no description provided]",
    "",
    ...(failureLogContext.trim() ? [failureLogContext.trim(), ""] : []),
    ...(automationEvidence.trim() ? [automationEvidence.trim(), ""] : []),
    ...(followUpEvidenceContext.trim() ? [followUpEvidenceContext.trim(), ""] : []),
    ...boundedDiscussionContext,
    "## Changed files digest",
    buildChangedFilesDigest(files, prioritizedPaths) || "[no changed files reported]",
    "",
    "## Changed files",
    buildFilesReviewPayload(files, prioritizedPaths),
  ].join("\n"), MAX_REVIEW_INPUT_CHARS);
}

/**
 * Extract a textual value from one OpenAI Responses content item.
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
 * Build a safe summary of the OpenAI response envelope for failure diagnostics.
 *
 * @param {any} responseJson Raw OpenAI response JSON.
 * @returns {string} Compact JSON summary without prompt/review content.
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
 * Ensure the generated review respects the repository's verdict policy.
 *
 * @param {string} reviewText Markdown review text generated by the model.
 * @returns {string} Final normalized recommendation.
 */
export function assertValidReviewRecommendation(reviewText) {
  for (const forbiddenRecommendation of FORBIDDEN_RECOMMENDATIONS) {
    if (reviewText.includes(forbiddenRecommendation)) {
      throw new Error(`Forbidden recommendation generated by AI review: ${forbiddenRecommendation}`);
    }
  }

  const recommendation = extractReviewRecommendation(reviewText);

  if (!recommendation) {
    throw new Error("AI review is missing the ## Recommendation section.");
  }

  if (!ALLOWED_RECOMMENDATIONS.has(recommendation)) {
    throw new Error(`Invalid AI review recommendation: ${recommendation}`);
  }

  return recommendation;
}

/**
 * Convert the model's final recommendation into the GitHub check outcome.
 *
 * The workflow must publish the review first so humans can see why it failed,
 * but `Request changes` is still a blocking verdict. A green check with a
 * blocking recommendation is worse than a failed job because it lets the PR
 * appear merge-ready while the public review says the opposite.
 *
 * @param {string} recommendation Parsed final recommendation.
 * @returns {Error | null} Error to throw after publishing, or null when approved.
 */
export function getReviewGateFailure(recommendation) {
  if (recommendation !== "Request changes") {
    return null;
  }

  return new Error("AI PR review requested changes. The check failed because the final recommendation is blocking.");
}

/**
 * Normalize the four role recommendations of a discussion review.
 *
 * The discussion lane is only merge-ready when every automated role reaches
 * the same explicit `Approve` verdict. This avoids the previous failure mode
 * where the synthesis said `Approve` while one specialist memo still asked for
 * changes, which made the green check disagree with the actual debate.
 *
 * @param {{ product: string, technical: string, risk: string, synthesis: string }} debate Debate output.
 * @returns {{
 *   recommendations: Record<string, string>,
 *   blockingRoles: string[],
 *   synthesisRecommendation: string,
 *   canReuseSynthesisApproveBody: boolean,
 *   recommendation: "Approve" | "Request changes"
 * }} Unanimity result.
 */
export function evaluateDiscussionRecommendation(debate) {
  const synthesisRecommendation = extractReviewRecommendation(debate.synthesis) ?? "Request changes";
  const recommendations = {
    product: assertValidReviewRecommendation(debate.product),
    technical: assertValidReviewRecommendation(debate.technical),
    risk: assertValidReviewRecommendation(debate.risk),
    synthesis: synthesisRecommendation,
  };
  const blockingRoles = Object.entries({
    product: recommendations.product,
    technical: recommendations.technical,
    risk: recommendations.risk,
  })
    .filter(([, recommendation]) => recommendation !== "Approve")
    .map(([role]) => role);
  const recommendation = blockingRoles.length === 0 ? "Approve" : "Request changes";

  return {
    recommendations,
    blockingRoles,
    synthesisRecommendation,
    canReuseSynthesisApproveBody: synthesisRecommendation === "Approve",
    recommendation,
  };
}

/**
 * Send one prompt to OpenAI and return markdown text.
 *
 * @param {string} systemPrompt Final system prompt.
 * @param {string} userPrompt User payload.
 * @param {string} model Explicit model name.
 * @param {{ expectRecommendation?: boolean, maxInputChars?: number }} [options] Validation options.
 * @returns {Promise<string>} Markdown response body.
 */
async function generateModelMarkdown(systemPrompt, userPrompt, model, options = {}) {
  const apiKey = readRequiredEnv("OPENAI_API_KEY");
  const boundedUserPrompt = truncateText(userPrompt, options.maxInputChars ?? MAX_REVIEW_INPUT_CHARS);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: createOpenAIRequestSignal(),
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
              text: boundedUserPrompt,
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
  const reviewText = readOpenAIText(responseJson);

  if (!reviewText) {
    const responseSummary = summarizeOpenAIResponse(responseJson);

    if (responseJson?.status === "incomplete" && responseJson?.incomplete_details?.reason === "max_output_tokens") {
      throw new Error(`OpenAI exhausted max_output_tokens before producing review text. Response summary: ${responseSummary}`);
    }

    throw new Error(`OpenAI returned an empty review. Response summary: ${responseSummary}`);
  }

  if (options.expectRecommendation === true) {
    assertValidReviewRecommendation(reviewText);
  }

  return sanitizePublishedMarkdown(reviewText);
}

/**
 * Build the synthesis payload from the three specialist reviewer memos.
 *
 * @param {string} sharedUserPrompt Original PR review payload.
 * @param {{ product: string, technical: string, risk: string }} memos Role outputs.
 * @returns {string} Final synthesis input.
 */
function buildSynthesisUserPrompt(sharedUserPrompt, memos) {
  return truncateText([
    sharedUserPrompt,
    "",
    "## Internal reviewer memos",
    "",
    "### Product and scope reviewer",
    truncateText(memos.product, MAX_AGENT_MEMO_CHARS),
    "",
    "### Technical and architecture reviewer",
    truncateText(memos.technical, MAX_AGENT_MEMO_CHARS),
    "",
    "### Risk, security, and operations reviewer",
    truncateText(memos.risk, MAX_AGENT_MEMO_CHARS),
  ].join("\n"), MAX_SYNTHESIS_INPUT_CHARS);
}

/**
 * Render a bounded memo when one model role fails. The synthesis can still make
 * the operational state visible instead of timing out the whole job silently.
 *
 * @param {string} role Reviewer role.
 * @param {unknown} error Failure from the model call.
 * @returns {string} Safe reviewer memo.
 */
export function buildModelFailureMemo(role, error) {
  const message = error instanceof Error ? error.message : String(error);

  return [
    "## Perspective",
    `The ${role} reviewer could not complete within the automation budget.`,
    "",
    "## Findings",
    "- Automated review role failed before producing a memo.",
    `- Failure: \`${truncateText(message, 240).replace(/`/g, "'")}\``,
    "",
    "## Questions",
    "- None.",
    "",
    "## Merge posture",
    "Request changes until the discussion review can be rerun or manually accepted by a maintainer.",
    "",
    "## Recommendation",
    "Request changes",
  ].join("\n");
}

/**
 * Render a valid synthesis when specialist or synthesis generation fails.
 *
 * @param {Array<{ role: string, error: unknown }>} failures Model failures.
 * @returns {string} Valid final synthesis.
 */
export function buildDiscussionDebateFailureSynthesis(failures) {
  const failureBullets = failures.length > 0
    ? failures.map(({ role, error }) => {
      const message = error instanceof Error ? error.message : String(error);

      return `- ${role} review did not complete: \`${truncateText(message, 220).replace(/`/g, "'")}\``;
    })
    : ["- Discussion review did not complete for an unknown operational reason."];

  return [
    "Request changes",
    "",
    "## Findings",
    ...failureBullets,
    "- Rerun the discussion review after the transient model/API issue is resolved.",
    "",
    "## Recommendation",
    "Request changes",
  ].join("\n");
}

/**
 * Run the multi-role debate and return each memo plus the merge synthesis.
 *
 * @param {{
 *   doctrine: string,
 *   productPrompt: string,
 *   technicalPrompt: string,
 *   riskPrompt: string,
 *   synthesisPrompt: string,
 * }} promptBundle Prompt bundle.
 * @param {string} userPrompt Shared PR review payload.
 * @param {string} model Explicit model name.
 * @returns {Promise<{ product: string, technical: string, risk: string, synthesis: string }>} Debate output.
 */
async function generateDiscussionDebate(promptBundle, userPrompt, model) {
  console.log("Starting multi-role PR discussion review.");
  const roleDefinitions = [
    { name: "Product and scope", prompt: promptBundle.productPrompt },
    { name: "Technical and architecture", prompt: promptBundle.technicalPrompt },
    { name: "Risk, security, and operations", prompt: promptBundle.riskPrompt },
  ];
  const roleResults = await Promise.allSettled(roleDefinitions.map((role) =>
    generateModelMarkdown(
      composeSystemPrompt(promptBundle.doctrine, role.prompt),
      userPrompt,
      model,
      { expectRecommendation: true },
    )));
  const failures = roleResults.flatMap((result, index) =>
    result.status === "rejected" ? [{ role: roleDefinitions[index].name, error: result.reason }] : []);
  const [product, technical, risk] = await Promise.all(roleResults.map((result, index) => {
    const role = roleDefinitions[index];

    if (result.status !== "fulfilled") {
      return buildModelFailureMemo(role.name, result.reason);
    }

    return normalizeOrRepairSpecialistReviewMemo(role.name, result.value, (reason) =>
      generateModelMarkdown(
        composeSystemPrompt(promptBundle.doctrine, role.prompt),
        buildSpecialistReviewRepairUserPrompt(role.name, result.value, reason),
        model,
        { expectRecommendation: true },
      ), (reason) => {
      logOperationalEvent("ai_pr_review.blocker_contract.malformed", {
        role: role.name,
        reason,
      });
    });
  }));

  console.log("Specialist PR review memos completed. Starting synthesis.");
  let synthesis = "";

  if (failures.length > 0) {
    synthesis = buildDiscussionDebateFailureSynthesis(failures);
  } else {
    try {
      synthesis = await generateModelMarkdown(
        composeSystemPrompt(promptBundle.doctrine, promptBundle.synthesisPrompt),
        buildSynthesisUserPrompt(userPrompt, { product, technical, risk }),
        model,
        { expectRecommendation: true, maxInputChars: MAX_SYNTHESIS_INPUT_CHARS },
      );
    } catch (error) {
      synthesis = buildDiscussionDebateFailureSynthesis([{ role: "Synthesis", error }]);
    }
  }

  synthesis = augmentDiscussionSynthesis(synthesis, { product, technical, risk });
  console.log("Multi-role PR discussion synthesis completed.");
  return { product, technical, risk, synthesis };
}

/**
 * Build the markdown body for the GitHub Discussion created for larger PRs.
 *
 * @param {any} pullRequest GitHub pull request payload.
 * @param {ReturnType<typeof assessDiscussionGate>} gate Gate decision.
 * @param {{ product: string, technical: string, risk: string, synthesis: string }} debate Debate output.
 * @param {string} model Explicit model name.
 * @returns {string} Discussion body.
 */
export function buildPullRequestDiscussionBody(pullRequest, gate, debate, model) {
  return [
    `<!-- ai-pr-discussion-pr-number:${pullRequest.number} -->`,
    `Pull request origem: #${pullRequest.number} - ${sanitizePlainTextForGitHubTitle(pullRequest.title)} (${pullRequest.html_url})`,
    "",
    "## Discussion gate",
    `- Route: \`${gate.route}\``,
    `- Reason: ${gate.reason}`,
    `- Files changed: \`${gate.summary.fileCount}\``,
    `- Changed lines: \`${gate.summary.totalChangedLines}\``,
    `- Areas: ${gate.summary.areas.join(", ") || "(none)"}`,
    `- Categories: ${gate.summary.categories.join(", ") || "(none)"}`,
    `- Model: \`${model}\``,
    "",
    "## PR description",
    sanitizePublishedMarkdown(truncateText(pullRequest.body ?? "[no description provided]", MAX_PR_BODY_CHARS)),
    "",
    "## Review comments",
    "The automation posts one top-level comment per reviewer role in this Discussion:",
    "- Product and scope",
    "- Technical and architecture",
    "- Risk, security, and operations",
    "- Synthesis",
  ].join("\n");
}

/**
 * Build top-level Discussion comments for each AI reviewer role.
 *
 * @param {{ product: string, technical: string, risk: string, synthesis: string }} debate Debate output.
 * @returns {Array<{ role: string, body: string }>} Comment bodies to publish.
 */
export function buildDiscussionReviewComments(debate) {
  return [
    {
      key: "product",
      role: "Product and scope",
      marker: "<!-- ai-pr-discussion-role:product -->",
      body: [
        DISCUSSION_COMMENT_MARKER,
        "<!-- ai-pr-discussion-role:product -->",
        "## Product and scope review",
        "",
        debate.product,
      ].join("\n"),
    },
    {
      key: "technical",
      role: "Technical and architecture",
      marker: "<!-- ai-pr-discussion-role:technical -->",
      body: [
        DISCUSSION_COMMENT_MARKER,
        "<!-- ai-pr-discussion-role:technical -->",
        "## Technical and architecture review",
        "",
        debate.technical,
      ].join("\n"),
    },
    {
      key: "risk",
      role: "Risk, security, and operations",
      marker: "<!-- ai-pr-discussion-role:risk -->",
      body: [
        DISCUSSION_COMMENT_MARKER,
        "<!-- ai-pr-discussion-role:risk -->",
        "## Risk, security, and operations review",
        "",
        debate.risk,
      ].join("\n"),
    },
    {
      key: "synthesis",
      role: "Synthesis",
      marker: "<!-- ai-pr-discussion-role:synthesis -->",
      body: [
        DISCUSSION_COMMENT_MARKER,
        "<!-- ai-pr-discussion-role:synthesis -->",
        "## Synthesis",
        "",
        debate.synthesis,
      ].join("\n"),
    },
  ];
}

/**
 * Build the final visible lifecycle comment for the Discussion.
 *
 * @param {string} recommendation Parsed final recommendation.
 * @param {string[]} [blockingRoles] Specialist reviewer roles still blocking.
 * @param {{
 *   isFollowUpRound?: boolean,
 *   blockerSummary?: ReturnType<typeof summarizeDiscussionBlockingContracts>
 * }} [options] Rendering options.
 * @returns {string} Final Discussion status comment.
 */
export function buildDiscussionCompletionComment(recommendation, blockingRoles = [], options = {}) {
  const isApproved = recommendation === "Approve";
  const isFollowUpRound = options.isFollowUpRound === true;
  const blockerSummary = options.blockerSummary ?? { testable: [], notTestable: [], roleMap: [] };
  const statusLine = isApproved
    ? "Discussion concluded: all specialist reviewer roles returned `Approve`."
    : "Discussion concluded: unanimous approval was not reached across the specialist reviewer roles.";
  const closeLine = isApproved
    ? "This append-only comment is the visible closure marker for the automated review."
    : "The Discussion remains open because at least one specialist reviewer role still requests changes.";
  const roundLine = isFollowUpRound
    ? isApproved
      ? "Why this passed now: the current diff plus the author's replies in this conclusion thread resolved the prior blockers for product, technical, and risk."
      : "Round feedback: after reviewing the current diff plus the author's replies in this conclusion thread, blocking findings still remain."
    : null;
  const canonicalLine =
    "Because this workflow is append-only, this newest final-status comment supersedes earlier automated final-status comments in this Discussion.";
  const blockerLine = !isApproved && blockingRoles.length > 0
    ? `Blocking roles: ${blockingRoles.map((role) => `\`${role}\``).join(", ")}`
    : null;
  const blockingRoleMap = !isApproved
    ? blockerSummary.roleMap.filter((item) => blockingRoles.includes(item.role))
    : [];
  const canonicalState = isApproved ? "pr_ready_to_merge" : "pr_review_request_changes";
  const nextActor = isApproved ? "codex" : "pr_author";
  const nextAction = isApproved ? "merge_when_required_checks_are_green" : "reply_to_pr_conclusion_after_changes";
  const policyLine =
    "Merge approval in the discussion lane requires unanimous `Approve` from `product`, `technical`, and `risk`. `synthesis` is summary-only.";

  return [
    DISCUSSION_FINAL_COMMENT_MARKER,
    "## Discussion status",
    "",
    statusLine,
    closeLine,
    ...(roundLine ? [roundLine] : []),
    ...(blockerLine ? [blockerLine] : []),
    policyLine,
    canonicalLine,
    ...(!isApproved ? [""] : []),
    ...(!isApproved ? buildDiscussionSynthesisContractAppendix(blockerSummary) : []),
    ...(blockingRoleMap.length > 0 ? ["", "## Blocking role map", ""] : []),
    ...blockingRoleMap.map((item) => item.testability === "Testable"
      ? `- \`${item.role}\` -> \`${item.expectedTest}\` -> ${item.resolutionCondition}.`
      : `- \`${item.role}\` -> human resolution -> ${item.resolutionCondition}.`),
    "",
    "## Estado canonico",
    `canonical_state: \`${canonicalState}\``,
    `next_actor: \`${nextActor}\``,
    `next_action: \`${nextAction}\``,
    `ready_for_merge: \`${String(isApproved)}\``,
    "",
    `Final recommendation: \`${recommendation}\``,
  ].join("\n");
}

/**
 * Build the PR-visible gate summary for the discussion lane.
 *
 * @param {{ product: string, technical: string, risk: string, synthesis: string }} debate Debate output.
 * @param {{
 *   recommendations: Record<string, string>,
 *   blockingRoles: string[],
 *   recommendation: "Approve" | "Request changes"
 * }} evaluation Unanimity result.
 * @returns {string} PR-visible verdict body.
 */
export function buildDiscussionGateReview(debate, evaluation) {
  if (evaluation.recommendation === "Approve" && evaluation.canReuseSynthesisApproveBody) {
    return debate.synthesis;
  }

  if (evaluation.recommendation === "Approve") {
    return [
      "Approve",
      "",
      "## Findings",
      "- Specialist reviewers reached unanimous `Approve`.",
      "- `synthesis` diverged in this run and was treated as summary-only, not as a blocking vote.",
      "",
      "## Recommendation",
      "Approve",
    ].join("\n");
  }

  return [
    "Request changes",
    "",
    "## Findings",
    "- The discussion lane requires unanimous `Approve` from Product, Technical, and Risk.",
    `- Blocking reviewer roles in this run: ${evaluation.blockingRoles.map((role) => `\`${role}\``).join(", ")}.`,
    "- See the linked Discussion for the role-specific comments and the latest closure status.",
    "",
    "## Recommendation",
    "Request changes",
  ].join("\n");
}

/**
 * Build the sticky PR comment body for either lane.
 *
 * @param {{
 *   model: string,
 *   gate: ReturnType<typeof assessDiscussionGate>,
 *   review: string,
 *   discussionUrl: string | null,
 * }} args Comment rendering inputs.
 * @returns {string} Final markdown body.
 */
export function buildPullRequestCommentBody({ model, gate, review, discussionUrl }) {
  const discussionSection = discussionUrl
    ? ["## Discussion", "", `[Discussion](${discussionUrl})`]
    : [];

  return [
    REVIEW_MARKER,
    "## AI PR Review",
    "",
    `Model: \`${model}\``,
    `Route: \`${gate.route}\``,
    "",
    "## Gate rationale",
    gate.reason,
    ...(discussionSection.length > 0 ? ["", ...discussionSection] : []),
    "",
    review,
  ].join("\n");
}

/**
 * Build a safe fallback note when the richer Discussion cannot be published.
 *
 * The model review still lands on the PR before the check fails, so transient
 * Discussion/API problems remain visible instead of silently losing context.
 *
 * @param {Error | unknown} error Publication failure.
 * @returns {string} Markdown fallback section.
 */
export function buildDiscussionPublicationFallback(error) {
  const message = error instanceof Error ? error.message : String(error);

  return [
    "## Discussion publication fallback",
    "",
    "The multi-role review completed, but GitHub Discussion publication failed.",
    "This PR comment contains the synthesis, but the check should fail until Discussion publication is complete.",
    "",
    `Failure: \`${truncateText(message, 500).replace(/`/g, "'")}\``,
  ].join("\n");
}

/**
 * Create or update the single sticky PR review comment.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber PR number as issue number.
 * @param {string} body Markdown comment body.
 * @returns {Promise<void>} Completes when the comment is persisted.
 */
async function upsertPullRequestComment(repoFullName, issueNumber, body) {
  const comments = await fetchPullRequestComments(repoFullName, issueNumber);
  const existingComment = findExistingReviewComment(comments);

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
 * Write an Actions step summary when available.
 *
 * @param {string} markdown Markdown summary.
 * @returns {Promise<void>} Resolves when written or skipped.
 */
async function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryPath) {
    return;
  }

  await fs.appendFile(summaryPath, `${markdown}\n`, "utf8");
}

/**
 * Publish the PR comment without making comment write failures fail the check.
 *
 * GitHub may refuse to update older bot comments when the token identity or
 * event context changes. The review result is still useful, so we degrade to
 * the job summary instead of turning a reporting failure into a merge blocker.
 *
 * @param {string} repoFullName Repository in owner/name form.
 * @param {number} issueNumber PR number as issue number.
 * @param {string} body Markdown comment body.
 * @returns {Promise<void>} Completes after comment or summary publication.
 */
async function publishPullRequestCommentOrSummary(repoFullName, issueNumber, body) {
  try {
    await upsertPullRequestComment(repoFullName, issueNumber, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.warn(`Unable to publish AI PR review comment; writing step summary instead: ${message}`);
    await writeStepSummary([
      "## AI PR Review comment fallback",
      "",
      "GitHub refused the PR comment write/update, so the review content is available in this job summary.",
      "",
      `Failure: \`${truncateText(message, 500).replace(/`/g, "'")}\``,
      "",
      body,
    ].join("\n"));
  }
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
 * Create or update the GitHub Discussion, returning null when publication
 * fails. A failed Discussion write should degrade to a PR comment instead of
 * turning transient infrastructure trouble into a hard merge blocker.
 *
 * @param {string} repository Repository in owner/name form.
 * @param {any} pullRequest GitHub pull request payload.
 * @param {ReturnType<typeof assessDiscussionGate>} gate Gate decision.
 * @param {{ product: string, technical: string, risk: string, synthesis: string }} debate Debate output.
 * @param {string} model Explicit model name.
 * @param {string} preferredDiscussionCategory Configured category name.
 * @returns {Promise<{ url: string | null, failure: Error | null }>} Publication result.
 */
async function publishDiscussionOrFallback(repository, pullRequest, gate, debate, model, preferredDiscussionCategory) {
  try {
    const [owner, name] = repository.split("/");
    const [comments, repositoryMetadata] = await Promise.all([
      fetchPullRequestComments(repository, pullRequest.number),
      fetchRepositoryDiscussionMetadata(owner, name),
    ]);
    const discussionTitle = `[PR #${pullRequest.number}] ${sanitizePlainTextForGitHubTitle(pullRequest.title)}`;
    const discussionBody = buildPullRequestDiscussionBody(pullRequest, gate, debate, model);
    const existingDiscussion = findExistingDiscussionTarget(
      pullRequest.number,
      comments,
      repositoryMetadata.discussions.nodes,
    );

    let discussion = existingDiscussion;

    if (!discussion) {
      const category = selectDiscussionCategory(repositoryMetadata.discussionCategories.nodes, preferredDiscussionCategory);
      const createdDiscussion = await createDiscussion(repositoryMetadata.id, category.id, discussionTitle, discussionBody);

      logOperationalEvent("ai_pr_review.discussion.created", {
        url: createdDiscussion.url,
        commentCount: 0,
      });

      discussion = preferRecoveredDiscussionTarget(
        createdDiscussion,
        await fetchDiscussionByNumber(owner, name, createdDiscussion.number),
      );
    }

    if (discussion?.number && !discussion.id) {
      const recoveredDiscussion = await fetchDiscussionByNumber(owner, name, discussion.number);

      if (recoveredDiscussion?.id) {
        discussion = recoveredDiscussion;
      }
    }

    if (!discussion.id) {
      return { url: discussion.url, failure: null };
    }
    const existingThreadComments = Array.isArray(discussion.comments?.nodes)
      ? discussion.comments.nodes
      : await fetchDiscussionComments(discussion.id);
    const latestFinalComment = findLatestAutomatedFinalComment(existingThreadComments);
    const discussionComments = buildDiscussionReviewComments(debate);

    for (const comment of discussionComments) {
      await addDiscussionComment(discussion.id, comment.body);
      logOperationalEvent("ai_pr_review.discussion_comment.published", {
        action: "created",
        role: comment.role,
        discussionUrl: discussion.url,
      });
    }

    const evaluation = evaluateDiscussionRecommendation(debate);
    const blockerSummary = summarizeDiscussionBlockingContracts(debate);
    const finalCommentBody = buildDiscussionCompletionComment(
      evaluation.recommendation,
      evaluation.blockingRoles,
      {
        isFollowUpRound: Boolean(latestFinalComment),
        blockerSummary,
      },
    );
    await addDiscussionComment(
      discussion.id,
      finalCommentBody,
      latestFinalComment?.id ?? null,
    );
    const lifecycleState = await syncDiscussionLifecycle(discussion.id, evaluation.recommendation);

    logOperationalEvent("ai_pr_review.discussion_final_comment.published", {
      action: latestFinalComment ? "replied" : "created",
      recommendation: evaluation.recommendation,
      blockingRoles: evaluation.blockingRoles,
      lifecycleState,
      discussionUrl: discussion.url,
    });

    return { url: discussion.url, failure: null };
  } catch (error) {
    logOperationalEvent("ai_pr_review.discussion.fallback", {
      reason: error instanceof Error ? error.message : String(error),
    });

    return { url: null, failure: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Main workflow entrypoint.
 *
 * @returns {Promise<void>} Resolves when the PR comment is updated.
 */
async function main() {
  const eventPath = readRequiredEnv("GITHUB_EVENT_PATH");
  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const eventName = process.env.GITHUB_EVENT_NAME?.trim() || "";
  const runMode = process.env.AI_PR_REVIEW_MODE?.trim() || RUN_MODE_AUTO;
  const reviewPromptPath = process.env.AI_REVIEW_PROMPT_PATH?.trim() || ".github/prompts/ai-pr-review.md";
  const doctrinePromptPath = process.env.AI_PR_DISCUSSION_DOCTRINE_PATH?.trim() || ".github/prompts/ai-pr-review-doctrine.md";
  const productPromptPath = process.env.AI_PR_DISCUSSION_PRODUCT_PROMPT_PATH?.trim() || ".github/prompts/ai-pr-discussion-product.md";
  const technicalPromptPath = process.env.AI_PR_DISCUSSION_TECHNICAL_PROMPT_PATH?.trim() || ".github/prompts/ai-pr-discussion-technical.md";
  const riskPromptPath = process.env.AI_PR_DISCUSSION_RISK_PROMPT_PATH?.trim() || ".github/prompts/ai-pr-discussion-risk.md";
  const synthesisPromptPath = process.env.AI_PR_DISCUSSION_SYNTHESIS_PROMPT_PATH?.trim() || ".github/prompts/ai-pr-discussion-synthesis.md";
  const preferredDiscussionCategory = process.env.AI_PR_DISCUSSION_CATEGORY?.trim() || DISCUSSION_CATEGORY_DEFAULT;
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const resolvedContext = await resolvePullRequestContext(repository, event);

  if (!resolvedContext) {
    return;
  }
  const { pullRequest, discussion } = resolvedContext;

  const files = await fetchPullRequestFiles(repository, pullRequest.number);
  const baseGate = assessDiscussionGate(files);
  const gate = discussion
    ? {
      ...baseGate,
      route: DISCUSSION_ROUTE_REQUIRED,
      requiresDiscussion: true,
      reason: "Existing PR Discussion thread is active; continue the review in the same Discussion with the latest conclusion replies as round context.",
    }
    : baseGate;

  if (runMode === RUN_MODE_CLASSIFY) {
    await writeGitHubOutput("route", gate.route);
    await writeGitHubOutput("requires_discussion", String(gate.requiresDiscussion));
    await writeGitHubOutput("reason", gate.reason);

    return;
  }

  if (runMode === RUN_MODE_AWAIT_CI) {
    const ciState = await waitForCiTestConclusion(repository, pullRequest.number);

    logOperationalEvent("ai_pr_review.ci_test.awaited", {
      pullRequestNumber: pullRequest.number,
      found: ciState.found,
      completed: ciState.completed,
      green: ciState.green,
    });

    await writeStepSummary([
      "## AI PR Review CI gate",
      "",
      `Canonical \`CI / Test\` completed: \`${ciState.completed}\``,
      `Canonical \`CI / Test\` green: \`${ciState.green}\``,
    ].join("\n"));
    return;
  }

  if (runMode === RUN_MODE_DIRECT && gate.requiresDiscussion) {
    return;
  }

  if (runMode === RUN_MODE_DISCUSSION && !gate.requiresDiscussion) {
    return;
  }

  const model = readConfiguredModel();
  let review = "";
  let discussionUrl = null;
  let discussionPublicationFailure = null;
  let discussionContext = "";
  let discussionThread = discussion;
  let latestFinalComment = null;
  let statusCheckContexts = [];
  let followUpEvidenceContext = "";
  let prioritizedFollowUpPaths = [];
  let followUpRepositoryFileContents = {};
  const automationEvidence = await loadAutomationEvidenceContext(files);
  const failureLogContext = await loadFailedActionsLogContext(repository, pullRequest.number);

  if (gate.requiresDiscussion) {
    if (discussion?.url) {
      discussionUrl = discussion.url;
      discussionContext = buildDiscussionHistoryContext(discussion.comments?.nodes ?? []);
    } else {
      const existingDiscussionContext = await resolveExistingDiscussionContext(repository, pullRequest.number);

      discussionUrl = existingDiscussionContext.discussionUrl;
      discussionContext = existingDiscussionContext.context;

      if (discussionUrl) {
        const [owner, name] = repository.split("/");
        const discussionNumber = parseDiscussionNumberFromUrl(discussionUrl);

        if (discussionNumber) {
          discussionThread = await fetchDiscussionByNumber(owner, name, discussionNumber);
        }
      }
    }

    logOperationalEvent("ai_pr_review.discussion_context.loaded", {
      hasExistingDiscussion: Boolean(discussionUrl),
      contextChars: discussionContext.length,
    });

    latestFinalComment = findLatestAutomatedFinalComment(discussionThread?.comments?.nodes ?? []);
    statusCheckContexts = latestFinalComment
      ? await fetchPullRequestStatusCheckRollup(repository, pullRequest.number)
      : [];

    if (shouldDeferDiscussionReviewUntilCiGreen(eventName, latestFinalComment, statusCheckContexts)) {
      logOperationalEvent("ai_pr_review.skip", {
        reason: "awaiting_green_ci_test",
        pullRequestNumber: pullRequest.number,
        discussionNumber: discussionThread?.number ?? discussion?.number ?? null,
      });
      await writeStepSummary([
        "## AI PR Review deferred",
        "",
        "Discussion rerun skipped because the current `CI / Test` check is not green yet.",
        "The next `workflow_run` event from `CI` will re-run the discussion lane after the canonical test result is available.",
      ].join("\n"));
      return;
    }

    prioritizedFollowUpPaths = latestFinalComment ? extractFollowUpPriorityPaths(latestFinalComment) : [];
    if (latestFinalComment) {
      const fileEntries = await Promise.all(
        prioritizedFollowUpPaths
          .filter((path) => hasChangedFile(files, path))
          .map(async (path) => {
            try {
              return [path, await fs.readFile(path, "utf8")];
            } catch {
              return [path, ""];
            }
          }),
      );
      followUpRepositoryFileContents = Object.fromEntries(fileEntries);
      followUpEvidenceContext = buildFollowUpEvidenceContext(
        collectFollowUpEvidenceRecords(
          latestFinalComment,
          files,
          statusCheckContexts,
          followUpRepositoryFileContents,
        ),
      );
    }
  }

  const userPrompt = buildPullRequestUserPrompt(
    repository,
    pullRequest,
    files,
    gate,
    discussionContext,
    automationEvidence,
    failureLogContext,
    followUpEvidenceContext,
    prioritizedFollowUpPaths,
  );

  if (gate.requiresDiscussion) {
    const [doctrine, productPrompt, technicalPrompt, riskPrompt, synthesisPrompt] = await Promise.all([
      readPrompt(doctrinePromptPath),
      readPrompt(productPromptPath),
      readPrompt(technicalPromptPath),
      readPrompt(riskPromptPath),
      readPrompt(synthesisPromptPath),
    ]);
    let debate = await generateDiscussionDebate(
      {
        doctrine,
        productPrompt,
        technicalPrompt,
        riskPrompt,
        synthesisPrompt,
      },
      userPrompt,
      model,
    );
    if (latestFinalComment) {
      const unresolvedFollowUpBlockers = reconcileFollowUpTestableBlockers(
        latestFinalComment,
        files,
        statusCheckContexts,
        followUpRepositoryFileContents,
      );

      if (unresolvedFollowUpBlockers.length > 0) {
        debate = applyFollowUpReconciliationToDebate(debate, unresolvedFollowUpBlockers);
        logOperationalEvent("ai_pr_review.follow_up_blockers.applied", {
          count: unresolvedFollowUpBlockers.length,
          roles: unresolvedFollowUpBlockers.map((blocker) => blocker.role),
        });
      } else {
        logOperationalEvent("ai_pr_review.follow_up_blockers.cleared", {
          ciTestGreen: isCiTestCheckGreen(statusCheckContexts),
        });
      }
    }

    const discussionEvaluation = evaluateDiscussionRecommendation(debate);
    const discussionPublication = await publishDiscussionOrFallback(
      repository,
      pullRequest,
      gate,
      debate,
      model,
      preferredDiscussionCategory,
    );

    discussionUrl = discussionPublication.url;

    if (discussionPublication.failure) {
      discussionPublicationFailure = discussionPublication.failure;
      review = [
        buildDiscussionPublicationFallback(discussionPublication.failure),
        "",
        buildDiscussionGateReview(debate, discussionEvaluation),
      ].join("\n");
    } else {
      review = buildDiscussionGateReview(debate, discussionEvaluation);
    }
  } else {
    const reviewPrompt = await readPrompt(reviewPromptPath);

    review = await generateModelMarkdown(reviewPrompt, userPrompt, model, { expectRecommendation: true });
  }

  const reviewRecommendation = assertValidReviewRecommendation(review);
  const commentBody = buildPullRequestCommentBody({
    model,
    gate,
    review,
    discussionUrl,
  });

  await publishPullRequestCommentOrSummary(repository, pullRequest.number, commentBody);

  if (discussionPublicationFailure) {
    throw discussionPublicationFailure;
  }

  const reviewGateFailure = getReviewGateFailure(reviewRecommendation);

  if (reviewGateFailure) {
    throw reviewGateFailure;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
