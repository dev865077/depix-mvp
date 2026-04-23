import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowText = readFileSync(".github/workflows/ai-wiki-update.yml", "utf8");

describe("ai wiki update workflow", () => {
  it("keeps GitHub Wiki publication optional after docs/wiki is committed", () => {
    expect(workflowText).toContain("WIKI_PUSH_TOKEN: ${{ secrets.WIKI_PUSH_TOKEN }}");
    expect(workflowText).not.toContain("secrets.WIKI_PUSH_TOKEN || github.token");
    expect(workflowText).toContain('if [ -z "${WIKI_PUSH_TOKEN:-}" ]; then');
    expect(workflowText).toContain("append_wiki_publish_warning");
    expect(workflowText).toContain("unable to clone the GitHub Wiki repository with the configured token");
    expect(workflowText).toContain("unable to push to the GitHub Wiki repository with the configured token");
  });
});
