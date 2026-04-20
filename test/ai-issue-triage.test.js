/**
 * Testes das validacoes do triador automatico de issues.
 */
import { describe, expect, it } from "vitest";

import {
  assertValidIssueTriagePlan,
  buildDiscussionBody,
  buildIssueCommentBody,
  extractDiscussionUrlFromComment,
  parseIssueTriageResponse,
  selectDiscussionCategory,
} from "../scripts/ai-issue-triage.mjs";

describe("ai issue triage validation", () => {
  it("parses plain and fenced JSON responses", () => {
    const plan = {
      impact: "baixo",
      route: "direct_pr",
      executionReadiness: "ready_now",
      needsDiscussion: false,
      reason: "Escopo claro e pequeno.",
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
      executionReadiness: "ready_now",
      needsDiscussion: false,
      reason: "Ja da para implementar sem rodada de planning.",
      productView: "Nao muda produto.",
      technicalView: "Mudanca localizada.",
      riskView: "Baixo risco.",
      decision: "Pode seguir direto para PR.",
      nextSteps: ["abrir branch", "implementar"],
    });

    expect(plan.impact).toBe("baixo");
    expect(plan.route).toBe("direct_pr");
  });

  it("accepts route decisions based on full context instead of rigid impact mapping", () => {
    const directPlan = assertValidIssueTriagePlan({
      summary: "Escopo medio, mas bem limitado.",
      impact: "medio",
      justification: "Toca duas areas, mas o contrato ja esta definido.",
      route: "direct_pr",
      executionReadiness: "ready_now",
      needsDiscussion: false,
      reason: "O trabalho ja esta claro e implementavel sem debate adicional.",
      productView: "Nao muda o fluxo de produto.",
      technicalView: "Mudanca pequena em contrato existente.",
      riskView: "Coberta por testes diretos.",
      decision: "Pode seguir direto para PR.",
      nextSteps: ["abrir branch", "implementar"],
    });
    const discussionPlan = assertValidIssueTriagePlan({
      summary: "Escopo ainda ambiguo.",
      impact: "baixo",
      justification: "Pequeno no tamanho, mas ambíguo no contrato.",
      route: "discussion_before_pr",
      executionReadiness: "needs_discussion",
      needsDiscussion: true,
      reason: "Ainda precisa uma decisao compartilhada antes de codar.",
      productView: "Pode mudar comportamento do operador.",
      technicalView: "Contrato ainda nao foi fechado.",
      riskView: "Ambiguidade pode gerar retrabalho.",
      decision: "Abrir Discussion antes da PR.",
      discussionTitle: "Alinhar contrato antes da PR",
      nextSteps: ["abrir discussion"],
    });
    const plan = assertValidIssueTriagePlan({
      summary: "Escopo cruzado.",
      impact: "alto",
      justification: "Afeta processo central.",
      route: "discussion_before_pr",
      executionReadiness: "needs_discussion",
      needsDiscussion: true,
      reason: "Precisa consenso entre produto, tecnica e risco antes da implementacao.",
      productView: "Mexe no fluxo de entrega.",
      technicalView: "Mexe em automacao e governanca.",
      riskView: "Pode criar burocracia errada.",
      decision: "Precisa decidir o gate antes de codar.",
      discussionTitle: "Debater gate de issue antes da PR",
      nextSteps: ["criar discussion", "fechar decisao"],
    });

    expect(directPlan.route).toBe("direct_pr");
    expect(discussionPlan.route).toBe("discussion_before_pr");
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

  it("marks discussion-routed issue comments as requiring an operational reply before PR work", () => {
    const body = buildIssueCommentBody({
      impact: "alto",
      route: "discussion_before_pr",
      executionReadiness: "needs_discussion",
      needsDiscussion: true,
      reason: "Existe dependencia de alinhamento antes da primeira PR.",
      justification: "Escopo amplo.",
      productView: "Precisa alinhar escopo.",
      technicalView: "Precisa dividir PRs.",
      riskView: "Pode misturar riscos.",
      decision: "Responder a Discussion antes de PR.",
      nextSteps: ["confirmar ordem"],
    }, "gpt-test", "https://github.com/dev865077/depix-mvp/discussions/97");

    expect(body).toContain("## Discussion");
    expect(body).toContain("## Resposta operacional requerida");
    expect(body).toContain("Prontidao de execucao");
    expect(body).toContain("## Racional de rota");
    expect(body).toContain("quatro papeis: produto, tecnica, scrum e risco");
    expect(body).toContain("aprovacao unanime");
    expect(body).toContain("Antes de abrir branch ou PR");
    expect(body).toContain("https://github.com/dev865077/depix-mvp/discussions/97");
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
      executionReadiness: "needs_discussion",
      needsDiscussion: true,
      reason: "Precisa debate curto de arquitetura e ordem de execucao.",
      productView: "Escopo precisa gate.",
      technicalView: "Fluxo toca GitHub Actions e automacao.",
      riskView: "Pode travar PRs pequenas.",
      decision: "Criar Discussion antes de PR quando impacto nao for baixo.",
      nextSteps: ["fechar regra", "implementar workflow"],
    });

    expect(body).toContain("## Debate");
    expect(body).toContain("## Sintese final");
    expect(body).toContain("## Resposta operacional requerida");
    expect(body).toContain("quatro papeis: produto, tecnica, scrum e risco");
    expect(body).toContain("Antes de abrir branch ou PR");
    expect(body).toContain("Issue origem: #51");
  });
});
