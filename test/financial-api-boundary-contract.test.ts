import { describe, expect, it } from "vitest";

import contract from "../docs/financial-api-boundary.md?raw";
import internalFinancialApi from "../src/services/internal-financial-api.ts?raw";
import opsRoute from "../src/routes/ops.ts?raw";
import webhooksRoute from "../src/routes/webhooks.ts?raw";
import telegramRuntime from "../src/telegram/reply-flow.runtime.ts?raw";

describe("financial API boundary contract", () => {
  it("documents the bot-facing and external financial endpoints needed for the split", function assertBoundaryMatrix() {
    expect(contract).toContain("## Target Endpoint Matrix");
    expect(contract).toContain("POST` | `/financial-api/v1/tenants/{tenantId}/payments`");
    expect(contract).toContain("GET` | `/financial-api/v1/tenants/{tenantId}/payments/{depositEntryId}`");
    expect(contract).toContain("POST` | `/financial-api/v1/tenants/{tenantId}/payments/{depositEntryId}/reconcile`");
    expect(contract).toContain("POST` | `/financial-api/v1/webhooks/eulen/{tenantId}/deposit`");
    expect(contract).toContain("POST` | `/financial-api/v1/tenants/{tenantId}/ops/reconcile/deposits`");
    expect(contract).toContain("## Idempotency and Dedup Rules");
    expect(contract).toContain("## Ownership Matrix");
  });

  it("stays grounded in the current monolith surface and direct coupling points", function assertCurrentRuntimeEvidence() {
    expect(webhooksRoute).toContain('webhooksRouter.post("/eulen/:tenantId/deposit"');
    expect(opsRoute).toContain('opsRouter.post("/:tenantId/recheck/deposit"');
    expect(opsRoute).toContain('opsRouter.post("/:tenantId/reconcile/deposits"');
    expect(telegramRuntime).toContain("confirmTelegramPaymentWithBoundary");
    expect(telegramRuntime).toContain("reconcileTelegramPaymentWithBoundary");
    expect(internalFinancialApi).toContain("confirmTelegramOrder");
    expect(internalFinancialApi).toContain("processDepositRecheck");

    expect(contract).toContain("Bot payment creation and pending-payment reconciliation now flow through the internal financial API boundary");
    expect(contract).toContain("legacy fallback");
    expect(contract).toContain("financial surface already exists as external webhook plus operational reconciliation routes");
  });
});
