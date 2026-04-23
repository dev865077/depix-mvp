import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const promptDirectory = ".github/prompts";
const promptIndexPath = "docs/wiki/Automacoes-e-Prompts.md";
const workflowDirectory = ".github/workflows";

const listPromptPaths = () => readdirSync(promptDirectory)
  .filter((fileName) => fileName.endsWith(".md"))
  .map((fileName) => `${promptDirectory}/${fileName}`)
  .sort((left, right) => left.localeCompare(right));

const listWorkflowTexts = () => readdirSync(workflowDirectory)
  .filter((fileName) => fileName.endsWith(".yml"))
  .map((fileName) => readFileSync(join(workflowDirectory, fileName), "utf8"));

const extractPromptPathVariables = (workflowText: string) => {
  const matches = workflowText.matchAll(/([A-Z0-9_]*(?:PROMPT|DOCTRINE)[A-Z0-9_]*_PATH):\s*(\.github\/prompts\/[^\s]+)/g);

  return Array.from(matches, ([, variableName, promptPath]) => ({ variableName, promptPath }));
};

describe("automation prompt audit index", () => {
  it("lists every repository-controlled prompt file", () => {
    const promptIndex = readFileSync(promptIndexPath, "utf8");

    for (const promptPath of listPromptPaths()) {
      expect(promptIndex).toContain(promptPath);
    }
  });

  it("documents workflow prompt path variables and their files", () => {
    const promptIndex = readFileSync(promptIndexPath, "utf8");
    const promptPathVariables = listWorkflowTexts().flatMap(extractPromptPathVariables);

    expect(promptPathVariables.length).toBeGreaterThan(0);

    for (const { variableName, promptPath } of promptPathVariables) {
      expect(promptIndex).toContain(variableName);
      expect(promptIndex).toContain(promptPath);
    }
  });
});
