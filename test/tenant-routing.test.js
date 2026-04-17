/**
 * Testes da fundacao multi-tenant do Worker.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function fetchJson(url) {
  const response = await SELF.fetch(url, { method: "POST" });
  const body = await response.json();

  return { response, body };
}

describe("tenant routing", () => {
  it("resolves tenant on telegram webhook path", async function assertTelegramTenantRouting() {
    const { response, body } = await fetchJson("https://example.com/telegram/alpha/webhook");

    expect(response.status).toBe(501);
    expect(body.tenantId).toBe("alpha");
    expect(body.error.details.tenantDisplayName).toBe("Alpha");
  });

  it("resolves tenant on eulen webhook path", async function assertEulenTenantRouting() {
    const { response, body } = await fetchJson("https://example.com/webhooks/eulen/beta/deposit");

    expect(response.status).toBe(501);
    expect(body.tenantId).toBe("beta");
    expect(body.error.details.eulenPartnerId).toBe("partner-beta");
  });

  it("fails safely when the tenant does not exist", async function assertUnknownTenantFailure() {
    const { response, body } = await fetchJson("https://example.com/telegram/gamma/webhook");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("request_failed");
    expect(body.error.message).toContain("Unknown tenant: gamma");
  });
});
