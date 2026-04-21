/**
 * Testes das validacoes do triador automatico de issues.
 */
import { describe, expect, it, vi } from "vitest";

import {
  assertValidIssueTriagePlan,
  buildIssuePlanningDispatchInputs,
  buildIssuePlanningDispatchRequest,
  buildIssueCommentBody,
  parseIssueTriageResponse,
  resolveIssuePlanningDispatchRef,
  runIssueTriageWorkflow,
  shouldDispatchIssuePlanning,
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

  it("still allows medium-impact issues to route directly when execution is already clear", () => {
    const plan = assertValidIssueTriagePlan({
      summary: "Ajuste medio, mas fechado.",
      impact: "medio",
      justification: "Escopo conhecido e pequeno.",
      route: "direct_pr",
      executionReadiness: "ready_now",
      needsDiscussion: false,
      reason: "Nao falta decisao compartilhada para implementar.",
      productView: "Sem mudanca de contrato.",
      technicalView: "Mudanca localizada.",
      riskView: "Coberta por teste.",
      decision: "Pode seguir direto para PR.",
      nextSteps: ["abrir branch"],
    });

    expect(plan.route).toBe("direct_pr");
    expect(plan.executionReadiness).toBe("ready_now");
  });

  it("still sends low-impact but ambiguous issues into discussion before PR", () => {
    const plan = assertValidIssueTriagePlan({
      summary: "Pequena, mas ambigua.",
      impact: "baixo",
      justification: "O tamanho e pequeno, mas a decisao ainda nao foi fechada.",
      route: "discussion_before_pr",
      executionReadiness: "needs_discussion",
      needsDiscussion: true,
      reason: "Ainda precisa alinhamento de contrato antes da execucao.",
      productView: "Pode afetar o operador.",
      technicalView: "Contrato em aberto.",
      riskView: "Ambiguidade aumenta retrabalho.",
      decision: "Abrir Discussion antes da PR.",
      discussionTitle: "Fechar contrato antes da PR",
      nextSteps: ["abrir discussion"],
    });

    expect(plan.route).toBe("discussion_before_pr");
    expect(plan.needsDiscussion).toBe(true);
  });

  it("marks discussion-routed issue comments as an API-only planning handoff", () => {
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
    }, "gpt-test");

    expect(body).not.toContain("https://github.com/dev865077/depix-mvp/discussions/");
    expect(body).toContain("## Planning automatico");
    expect(body).toContain("Prontidao de execucao");
    expect(body).toContain("Rota canonica: `discussion_before_pr`");
    expect(body).toContain("canonical_state: `issue_needs_planning`");
    expect(body).toContain("next_actor: `ai_issue_planning_review`");
    expect(body).toContain("ready_for_codex: `false`");
    expect(body).toContain("## Racional de rota");
    expect(body).toContain("despacha o workflow `AI Issue Planning Review`");
    expect(body).toContain("criar ou reutilizar uma unica Discussion canonica");
  });

  it("marks direct issues as ready for Codex without planning Discussion", () => {
    const body = buildIssueCommentBody({
      impact: "baixo",
      route: "direct_pr",
      executionReadiness: "ready_now",
      needsDiscussion: false,
      reason: "Escopo pequeno e fechado.",
      justification: "Pode implementar direto.",
      productView: "Sem decisao pendente.",
      technicalView: "Mudanca localizada.",
      riskView: "Baixo risco.",
      decision: "Abrir branch e PR.",
      nextSteps: ["implementar"],
    }, "gpt-test");

    expect(body).toContain("Rota canonica: `direct_pr`");
    expect(body).toContain("canonical_state: `issue_ready_for_codex`");
    expect(body).toContain("next_actor: `codex`");
    expect(body).toContain("ready_for_codex: `true`");
    expect(body).not.toContain("## Planning automatico");
  });

  it("dispatches planning only for discussion-routed issues", () => {
    const discussionPlan = {
      route: "discussion_before_pr",
    };
    const directPlan = {
      route: "direct_pr",
    };

    expect(shouldDispatchIssuePlanning(discussionPlan)).toBe(true);
    expect(shouldDispatchIssuePlanning(directPlan)).toBe(false);
    expect(buildIssuePlanningDispatchInputs(217)).toEqual({ issue_number: "217" });
    expect(() => buildIssuePlanningDispatchInputs(0)).toThrow("Invalid issue number");
    expect(resolveIssuePlanningDispatchRef({ repository: { default_branch: "trunk" } }, {})).toBe("trunk");
    expect(resolveIssuePlanningDispatchRef({}, { GITHUB_REF: "refs/heads/main" })).toBe("main");
  });

  it("builds the exact workflow dispatch request used by the issue planning handoff", () => {
    const request = buildIssuePlanningDispatchRequest("dev865077/depix-mvp", 217, " trunk ");

    expect(request.url).toBe(
      "https://api.github.com/repos/dev865077/depix-mvp/actions/workflows/ai-issue-planning-review.yml/dispatches",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(request.init.body)).toEqual({
      ref: "trunk",
      inputs: { issue_number: "217" },
    });
    expect(() => buildIssuePlanningDispatchRequest("invalid", 217, "main")).toThrow("Invalid repository");
    expect(() => buildIssuePlanningDispatchRequest("dev865077/depix-mvp", 217, " ")).toThrow("Invalid ref");
  });

  it("posts the triage comment before dispatching planning from the orchestrated workflow path", async () => {
    const calls = [];
    const plan = {
      summary: "Visao futura.",
      impact: "baixo",
      justification: "Docs estrategica.",
      route: "discussion_before_pr",
      executionReadiness: "needs_discussion",
      needsDiscussion: true,
      reason: "Precisa alinhamento antes da documentacao final.",
      productView: "Define direcao de produto.",
      technicalView: "Toca arquitetura futura.",
      riskView: "Pode criar expectativa errada.",
      decision: "Rodar planning antes da PR.",
      discussionTitle: "Alinhar visao futura",
      nextSteps: ["rodar planning"],
    };
    const runtime = {
      readTriagePrompt: async () => "prompt",
      fetchIssueComments: async () => [],
      generateIssueTriage: async () => JSON.stringify(plan),
      upsertIssueComment: async (repo, issueNumber, body) => {
        calls.push(["upsert", repo, issueNumber, body.includes("canonical_state: `issue_needs_planning`")]);
      },
      dispatchIssuePlanningWorkflow: async (repo, issueNumber, ref) => {
        const request = buildIssuePlanningDispatchRequest(repo, issueNumber, ref);
        calls.push(["dispatch", repo, issueNumber, ref, request.url, JSON.parse(request.init.body)]);
      },
      writeStepSummary: async () => {
        calls.push(["summary"]);
      },
    };

    vi.stubEnv("GITHUB_REF_NAME", "");
    vi.stubEnv("GITHUB_REF", "");

    await runIssueTriageWorkflow({
      repository: "dev865077/depix-mvp",
      issue: {
        number: 217,
        title: "Visao futura",
        state: "open",
        body: "Documentar visao futura.",
        user: { login: "dev865077" },
      },
      event: { repository: { default_branch: "trunk" } },
      promptPath: ".github/prompts/ai-issue-triage.md",
      model: "gpt-test",
    }, runtime);

    vi.unstubAllEnvs();

    expect(calls).toEqual([
      ["upsert", "dev865077/depix-mvp", 217, true],
      [
        "dispatch",
        "dev865077/depix-mvp",
        217,
        "trunk",
        "https://api.github.com/repos/dev865077/depix-mvp/actions/workflows/ai-issue-planning-review.yml/dispatches",
        { ref: "trunk", inputs: { issue_number: "217" } },
      ],
      ["summary"],
    ]);
  });

  it("keeps the workflow red when planning dispatch fails after the comment handoff", async () => {
    const calls = [];
    const runtime = {
      readTriagePrompt: async () => "prompt",
      fetchIssueComments: async () => [],
      generateIssueTriage: async () => JSON.stringify({
        summary: "Precisa debate.",
        impact: "medio",
        justification: "Contrato ainda em aberto.",
        route: "discussion_before_pr",
        executionReadiness: "needs_discussion",
        needsDiscussion: true,
        reason: "Planejamento precisa rodar.",
        productView: "Produto precisa decidir.",
        technicalView: "Tecnica precisa validar.",
        riskView: "Risco precisa revisar.",
        decision: "Rodar planning.",
        discussionTitle: "Planejar visao futura",
        nextSteps: ["rodar planning"],
      }),
      upsertIssueComment: async () => {
        calls.push("upsert");
      },
      dispatchIssuePlanningWorkflow: async () => {
        calls.push("dispatch");
        throw new Error("dispatch rejected");
      },
      writeStepSummary: async () => {
        calls.push("summary");
      },
    };

    vi.stubEnv("GITHUB_REF_NAME", "");
    vi.stubEnv("GITHUB_REF", "");

    await expect(runIssueTriageWorkflow({
      repository: "dev865077/depix-mvp",
      issue: {
        number: 217,
        title: "Visao futura",
        state: "open",
        body: "Documentar visao futura.",
        user: { login: "dev865077" },
      },
      event: { repository: { default_branch: "main" } },
      promptPath: ".github/prompts/ai-issue-triage.md",
      model: "gpt-test",
    }, runtime)).rejects.toThrow("dispatch rejected");

    vi.unstubAllEnvs();

    expect(calls).toEqual(["upsert", "dispatch"]);
  });
});
