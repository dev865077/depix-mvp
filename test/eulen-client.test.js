/**
 * Testes controlados do client Eulen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertEulenCredentials,
  buildEulenRequestHeaders,
  EulenApiError,
  normalizeAsyncMode,
  pingEulen,
  requestEulenApi,
} from "../src/clients/eulen-client.js";

const RUNTIME_CONFIG = {
  eulenApiBaseUrl: "https://depix.eulen.app/api",
  eulenApiTimeoutMs: 10000,
};

const TENANT_CREDENTIALS = {
  apiToken: "token_test_123",
  partnerId: "partner_alpha",
};

afterEach(function restoreFetchMock() {
  vi.restoreAllMocks();
});

export function assertRequiredHeaders() {
  const { headers, nonce, asyncMode } = buildEulenRequestHeaders({
    apiToken: "token_test_123",
    partnerId: "partner_alpha",
    nonce: "nonce_test_123",
    asyncMode: "auto",
  });

  expect(headers.get("Authorization")).toBe("Bearer token_test_123");
  expect(headers.get("X-Partner-Id")).toBe("partner_alpha");
  expect(headers.get("X-Nonce")).toBe("nonce_test_123");
  expect(headers.get("X-Async")).toBe("auto");
  expect(nonce).toBe("nonce_test_123");
  expect(asyncMode).toBe("auto");
}

export async function assertPingRequest() {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ response: { msg: "Pong!" }, async: false }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }),
  );

  const response = await pingEulen(RUNTIME_CONFIG, TENANT_CREDENTIALS, {
    nonce: "nonce_ping_001",
    asyncMode: "auto",
  });

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0][0]).toBe("https://depix.eulen.app/api/ping");
  expect(fetchSpy.mock.calls[0][1]?.method).toBe("GET");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("Authorization")).toBe("Bearer token_test_123");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("X-Partner-Id")).toBe("partner_alpha");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("X-Nonce")).toBe("nonce_ping_001");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("X-Async")).toBe("auto");
  expect(response.status).toBe(200);
  expect(response.nonce).toBe("nonce_ping_001");
}

export async function assertHttpErrorHandling() {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ response: { errorMessage: "Unauthorized" }, async: false }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    }),
  );

  await expect(
    requestEulenApi(RUNTIME_CONFIG, TENANT_CREDENTIALS, {
      path: "/ping",
      method: "GET",
      nonce: "nonce_error_001",
      asyncMode: "auto",
    }),
  ).rejects.toBeInstanceOf(EulenApiError);
}

describe("eulen client", () => {
  it("builds the required auth, partner and async headers", assertRequiredHeaders);
  it("executes ping with the expected request shape", assertPingRequest);
  it("throws a standardized error on non-2xx responses", assertHttpErrorHandling);
  it("accepts only supported async modes", function assertAsyncModes() {
    expect(normalizeAsyncMode(undefined)).toBe("auto");
    expect(normalizeAsyncMode("true")).toBe("true");
    expect(normalizeAsyncMode("false")).toBe("false");
    expect(normalizeAsyncMode("auto")).toBe("auto");
  });
  it("requires tenant-scoped credentials", function assertTenantCredentialsShape() {
    expect(assertEulenCredentials(TENANT_CREDENTIALS).apiToken).toBe("token_test_123");
    expect(() => assertEulenCredentials({ apiToken: "" })).toThrow(EulenApiError);
  });
});
