import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = "docs/check-classification.yml";

function normalizeYamlScalar(value) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export function parseCheckClassificationYaml(text) {
  const result = {
    required: [],
    informative: [],
  };
  let section = null;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line === "required:" || line === "informative:") {
      section = line.slice(0, -1);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!section) {
        throw new Error("Check classification YAML contains a list item outside a section.");
      }

      const value = normalizeYamlScalar(line.slice(2));

      if (!value) {
        throw new Error(`Check classification YAML contains an empty item in ${section}.`);
      }

      result[section].push(value);
      continue;
    }

    throw new Error(`Unsupported check classification YAML line: ${rawLine}`);
  }

  for (const key of ["required", "informative"]) {
    const uniqueValues = [...new Set(result[key])];

    if (uniqueValues.length !== result[key].length) {
      throw new Error(`Check classification YAML contains duplicate entries in ${key}.`);
    }
  }

  return result;
}

export async function readCheckClassification(filePath = DEFAULT_PATH) {
  const text = await fs.readFile(filePath, "utf8");
  return parseCheckClassificationYaml(text);
}

export function classifyCheck(policy, context) {
  if (policy.required.includes(context)) {
    return {
      context,
      classification: "required",
      blocking: true,
    };
  }

  if (policy.informative.includes(context)) {
    return {
      context,
      classification: "informative",
      blocking: false,
    };
  }

  throw new Error(`Check context is not classified: ${context}`);
}

async function main() {
  const filePath = process.env.CHECK_CLASSIFICATION_PATH?.trim() || DEFAULT_PATH;
  const context = process.env.CHECK_CONTEXT?.trim();

  if (!context) {
    throw new Error("Missing required environment variable: CHECK_CONTEXT");
  }

  const policy = await readCheckClassification(filePath);
  const result = classifyCheck(policy, context);

  process.stdout.write([
    `context=${result.context}`,
    `classification=${result.classification}`,
    `blocking=${String(result.blocking)}`,
  ].join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
