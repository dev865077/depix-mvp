/**
 * Testes das validacoes do triador automatico de issues.
 */
import { describe, expect, it } from "vitest";

import {
  assertValidIssueTriagePlan,
  buildDiscussionBody,
  extractDiscussionUrlFromComment,
  parseIssueTriageResponse,
  selectDiscussionCategory,
} from "../scripts/ai-issue-triage.mjs";

describe("ai issue triage validation", () => {
  it("parses plain and fenced JSON responses", () => {
    const plan = {
      impact: "baixo",
      route: "direct_pr",
      summary: "ok",
      justification: "ok",
      productView: "ok",
      technicalView: "ok",
      riskView: "ok",
      decision: "ok",
      nextSteps: ["abrir PR"],
    };

    expect(parseIssueTriageResponse(JSON.stringify(plan))).toEqual(plan);
    expect(parseIssueTriageResponse(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)).toEqual(plan);
  });

  it("accepts low impact direct PR plans", () => {
    const plan = assertValidIssueTriagePlan({
      summary: "Mudanca pequena.",
      impact: "baixo",
      justification: "Escopo pequeno e claro.",
      route: "direct_pr",
      productView: "Nao muda produto.",
      technicalView: "Mudanca localizada.",
      riskView: "Baixo risco.",
      decision: "Pode seguir direto para PR.",
      nextSteps: ["abrir branch", "implementar"],
    });

    expect(plan.impact).toBe("baixo");
    expect(plan.route).toBe("direct_pr");
  });

  it("requires discussion for medium and high impact plans", () => {
    expect(() => assertValidIssueTriagePlan({
      summary: "Escopo cruzado.",
      impact: "medio",
      justification: "Afeta varios fluxos.",
      route: "direct_pr",
      productView: "Produto muda fluxo.",
      technicalView: "Arquitetura toca varias areas.",
      riskView: "Pode regressar comportamento.",
      decision: "Precisa debate curto.",
      nextSteps: ["discutir"],
    })).toThrow(/must require Discussion/);

    const plan = assertValidIssueTriagePlan({
      summary: "Escopo cruzado.",
      impact: "alto",
      justification: "Afeta processo central.",
      route: "discussion_before_pr",
      productView: "Mexe no fluxo de entrega.",
      technicalView: "Mexe em automacao e governanca.",
      riskView: "Pode criar burocracia errada.",
      decision: "Precisa decidir o gate antes de codar.",
      discussionTitle: "Debater gate de issue antes da PR",
      nextSteps: ["criar discussion", "fechar decisao"],
    });

    expect(plan.discussionTitle).toContain("gate");
  });

  it("selects category with configured preference and safe fallback", () => {
    const categories = [
      { id: "1", name: "General", isAnswerable: false },
      { id: "2", name: "Ideas", isAnswerable: false },
      { id: "3", name: "Q&A", isAnswerable: true },
    ];

    expect(selectDiscussionCategory(categories, "Ideas").id).toBe("2");
    expect(selectDiscussionCategory(categories, "Missing").id).toBe("2");
  });

  it("extracts an existing discussion URL from the sticky comment", () => {
    const comment = [
      "<!-- ai-issue-triage:openai -->",
      "## AI Issue Triage",
      "",
      "[Discussion](https://github.com/dev865077/depix-mvp/discussions/12)",
    ].join("\n");

    expect(extractDiscussionUrlFromComment(comment)).toBe("https://github.com/dev865077/depix-mvp/discussions/12");
  });

  it("builds a discussion body with the structured debate", () => {
    const body = buildDiscussionBody({
      number: 51,
      title: "Criar automacao",
      url: "https://github.com/dev865077/depix-mvp/issues/51",
      body: "Descricao da issue.",
    }, {
      impact: "medio",
      route: "discussion_before_pr",
      productView: "Escopo precisa gate.",
      technicalView: "Fluxo toca GitHub Actions e automacao.",
      riskView: "Pode travar PRs pequenas.",
      decision: "Criar Discussion antes de PR quando impacto nao for baixo.",
      nextSteps: ["fechar regra", "implementar workflow"],
    });

    expect(body).toContain("## Debate");
    expect(body).toContain("## Sintese final");
    expect(body).toContain("Issue origem: #51");
  });
});
