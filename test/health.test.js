/**
 * Smoke test do healthcheck do Worker.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

export async function fetchHealthResponse() {
  const response = await SELF.fetch("https://example.com/health");
  const body = await response.json();

  return { response, body };
}

export async function assertHealthResponse() {
  const { response, body } = await fetchHealthResponse();

  expect(response.status).toBe(200);
  expect(body.status).toBe("ok");
  expect(body.environment).toBe("local");
  expect(body.configuration.database.bindingConfigured).toBe(true);
  expect(body.configuration.secrets.registryConfigured).toBe(true);
  expect(body.configuration.secrets.tenantSecretBindingsConfigured).toBe(true);
  expect(body.configuration.operations.depositRecheck.enabled).toBe(true);
  expect(body.configuration.operations.depositRecheck.featureFlag.configured).toBe(true);
  expect(body.configuration.operations.depositRecheck.globalBearerBindingConfigured).toBe(false);
  expect(Object.keys(body.configuration.tenants)).toEqual(["alpha", "beta"]);
}

describe("health route", () => {
  it("returns the runtime status", assertHealthResponse);
});
