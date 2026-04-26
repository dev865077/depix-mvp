/**
 * Smoke test do healthcheck do Worker.
 */
// @vitest-pool cloudflare
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

function createHealthEnv(overrides = {}) {
  return {
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    ...overrides,
  };
}

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
  expect(body.configuration.runtime).toBe("product-shell");
  expect(body.configuration.externalSystems).toEqual({
    debotRepositoryUrl: "https://github.com/dev865077/DeBot",
    saguiRepositoryUrl: "https://github.com/dev865077/Sagui",
    autoIaRepositoryUrl: "https://github.com/dev865077/AutoIA-Github",
  });
}

describe("health route", () => {
  it("returns the runtime status", assertHealthResponse);

  it("does not expose removed mixed-runtime config", async function assertRuntimeResidueRemoval() {
    const response = await createApp().fetch(
      new Request("https://example.com/health"),
      createHealthEnv(),
    );
    const body = await response.json();
    const serializedBody = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(serializedBody).not.toContain("secretBindings");
    expect(serializedBody).not.toContain("splitConfigBindings");
    expect(serializedBody).not.toContain("database");
    expect(serializedBody).not.toContain("operations");
  });

  it("fails through the global handler when required shell config is invalid", async function assertInvalidRuntimeFailure() {
    const response = await createApp().fetch(
      new Request("https://example.com/health"),
      createHealthEnv({
        APP_ENV: "staging",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("request_failed");
    expect(body.status).not.toBe("ok");
  });
});
