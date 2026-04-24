import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const prReviewWorkflow = readFileSync(".github/workflows/ai-pr-review.yml", "utf8");
const wikiWorkflow = readFileSync(".github/workflows/ai-wiki-update.yml", "utf8");
const classificationDoc = readFileSync("docs/check-classification.yml", "utf8");
const mergeDoc = readFileSync("docs/wiki/PR-Checks-e-Merge.md", "utf8");

describe("pr check classification workflow", () => {
  it("pins the canonical check classification source of truth", () => {
    expect(classificationDoc).toContain("required:");
    expect(classificationDoc).toContain("- Test");
    expect(classificationDoc).toContain("informative:");
    expect(classificationDoc).toContain("- AI PR Review / discussion-review");
    expect(classificationDoc).toContain("- AI Wiki Update / update-wiki");
  });

  it("makes discussion-review consume classification and degrade to advisory reporting", () => {
    expect(prReviewWorkflow).toContain("CHECK_CLASSIFICATION_PATH: docs/check-classification.yml");
    expect(prReviewWorkflow).toContain("CHECK_CONTEXT: AI PR Review / discussion-review");
    expect(prReviewWorkflow).toContain("continue-on-error: ${{ steps.check_classification.outputs.blocking != 'true' }}");
    expect(prReviewWorkflow).toContain("Report advisory discussion-review outcome");
    expect(prReviewWorkflow).toContain("Merge effect: none");
  });

  it("makes update-wiki consume classification and degrade to advisory reporting", () => {
    expect(wikiWorkflow).toContain("CHECK_CLASSIFICATION_PATH: docs/check-classification.yml");
    expect(wikiWorkflow).toContain("CHECK_CONTEXT: AI Wiki Update / update-wiki");
    expect(wikiWorkflow).toContain("Report advisory update-wiki outcome");
    expect(wikiWorkflow).toContain("Merge effect: none");
  });

  it("documents the final convention in one wiki page", () => {
    expect(mergeDoc).toContain("A classificacao canonica vive em `docs/check-classification.yml`.");
    expect(mergeDoc).toContain("- `Test`");
    expect(mergeDoc).toContain("aparece como `CI / Test`");
    expect(mergeDoc).toContain("- `AI PR Review / discussion-review`");
    expect(mergeDoc).toContain("- `AI Wiki Update / update-wiki`");
  });
});
