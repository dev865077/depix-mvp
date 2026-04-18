/**
 * Testes das validacoes do atualizador automatico da wiki.
 */
import { describe, expect, it } from "vitest";

import {
  assertValidWikiUpdatePlan,
  normalizeWikiUpdatePath,
  parseWikiUpdateResponse,
} from "../scripts/ai-wiki-update.mjs";

const wikiPaths = [
  "docs/wiki/Home.md",
  "docs/wiki/Arquitetura-Geral.md",
];

describe("ai wiki update validation", () => {
  it("parses plain and fenced JSON responses", () => {
    const plan = { summary: "ok", updates: [] };

    expect(parseWikiUpdateResponse(JSON.stringify(plan))).toEqual(plan);
    expect(parseWikiUpdateResponse(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)).toEqual(plan);
  });

  it("accepts existing docs/wiki markdown paths only", () => {
    const allowedPaths = new Set(wikiPaths);

    expect(normalizeWikiUpdatePath("docs\\wiki\\Home.md", allowedPaths)).toBe("docs/wiki/Home.md");
    expect(() => normalizeWikiUpdatePath("README.md", allowedPaths)).toThrow(/outside docs\/wiki/);
    expect(() => normalizeWikiUpdatePath("docs/wiki/../secrets.md", allowedPaths)).toThrow(/traversal/);
    expect(() => normalizeWikiUpdatePath("docs/wiki/Nova.md", allowedPaths)).toThrow(/unknown wiki page/);
  });

  it("validates a complete update plan", () => {
    const plan = assertValidWikiUpdatePlan({
      summary: "Atualiza arquitetura.",
      updates: [
        {
          path: "docs/wiki/Arquitetura-Geral.md",
          content: "# Arquitetura Geral\n\nTexto atualizado.\n",
        },
      ],
    }, wikiPaths);

    expect(plan).toEqual({
      summary: "Atualiza arquitetura.",
      updates: [
        {
          path: "docs/wiki/Arquitetura-Geral.md",
          content: "# Arquitetura Geral\n\nTexto atualizado.\n",
        },
      ],
    });
  });

  it("rejects duplicate paths and empty content", () => {
    expect(() => assertValidWikiUpdatePlan({
      updates: [
        { path: "docs/wiki/Home.md", content: "# Home\n" },
        { path: "docs/wiki/Home.md", content: "# Home\n" },
      ],
    }, wikiPaths)).toThrow(/duplicate path/);

    expect(() => assertValidWikiUpdatePlan({
      updates: [
        { path: "docs/wiki/Home.md", content: "" },
      ],
    }, wikiPaths)).toThrow(/content is empty/);
  });

  it("normalizes content with a final newline", () => {
    const plan = assertValidWikiUpdatePlan({
      updates: [
        {
          path: "docs/wiki/Home.md",
          content: "# Home\n\nAtualizada.",
        },
      ],
    }, wikiPaths);

    expect(plan.updates[0].content).toBe("# Home\n\nAtualizada.\n");
  });
});
