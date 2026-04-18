/**
 * Testes controlados do client Eulen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertEulenCredentials,
  assertRequiredDepositSplit,
  buildEulenRequestHeaders,
  createEulenDeposit,
  EulenApiError,
  isEulenAsyncResponsePointer,
  listEulenDeposits,
  normalizeAsyncMode,
  pingEulen,
  readEulenAsyncResult,
  requestEulenApi,
  resolveEulenAsyncResponse,
} from "../src/clients/eulen-client.js";

const RUNTIME_CONFIG = {
  eulenApiBaseUrl: "https://depix.eulen.app/api",
  eulenApiTimeoutMs: 10000,
};

const TENANT_CREDENTIALS = {
  apiToken: "token_test_123",
  partnerId: "partner_alpha",
};

const VALID_DEPOSIT_BODY = {
  walletAddress: "bc1qexamplewallet",
  asset: "BTC",
  amount: "150.00",
  depixSplitAddress: "split-address-001",
  splitFee: "12.50",
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

export function assertDepositSplitContract() {
  expect(assertRequiredDepositSplit(VALID_DEPOSIT_BODY)).toEqual(VALID_DEPOSIT_BODY);
  expect(() => assertRequiredDepositSplit(undefined)).toThrow(EulenApiError);
  expect(() => assertRequiredDepositSplit({ ...VALID_DEPOSIT_BODY, depixSplitAddress: "" })).toThrow(EulenApiError);
  expect(() => assertRequiredDepositSplit({ ...VALID_DEPOSIT_BODY, splitFee: "" })).toThrow(EulenApiError);
}

export async function assertDepositFailsFastWithoutSplit() {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  expect(() => (
    createEulenDeposit(RUNTIME_CONFIG, TENANT_CREDENTIALS, {
      body: {
        ...VALID_DEPOSIT_BODY,
        depixSplitAddress: "",
      },
      nonce: "nonce_split_missing",
      asyncMode: "auto",
    })
  )).toThrow(EulenApiError);

  expect(fetchSpy).not.toHaveBeenCalled();
}

export async function assertDepositRequestShape() {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ id: "deposit_123", async: false }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }),
  );

  const response = await createEulenDeposit(RUNTIME_CONFIG, TENANT_CREDENTIALS, {
    body: VALID_DEPOSIT_BODY,
    nonce: "nonce_deposit_001",
    asyncMode: "auto",
  });

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0][0]).toBe("https://depix.eulen.app/api/deposit");
  expect(fetchSpy.mock.calls[0][1]?.method).toBe("POST");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("Content-Type")).toBe("application/json");
  expect(fetchSpy.mock.calls[0][1]?.body).toBe(JSON.stringify(VALID_DEPOSIT_BODY));
  expect(response.status).toBe(200);
  expect(response.nonce).toBe("nonce_deposit_001");
}

export async function assertDepositsListRequestShape() {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify([
      {
        qrId: "qr_alpha_001",
        status: "depix_sent",
        bankTxId: "bank_tx_001",
      },
    ]), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }),
  );

  const response = await listEulenDeposits(RUNTIME_CONFIG, TENANT_CREDENTIALS, {
    start: "2026-04-18T00:00:00Z",
    end: "2026-04-19T00:00:00Z",
    status: "depix_sent",
    nonce: "nonce_deposits_001",
    asyncMode: "false",
  });

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0][0]).toBe(
    "https://depix.eulen.app/api/deposits?start=2026-04-18T00%3A00%3A00Z&end=2026-04-19T00%3A00%3A00Z&status=depix_sent",
  );
  expect(fetchSpy.mock.calls[0][1]?.method).toBe("GET");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("Authorization")).toBe("Bearer token_test_123");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("X-Partner-Id")).toBe("partner_alpha");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("X-Nonce")).toBe("nonce_deposits_001");
  expect(fetchSpy.mock.calls[0][1]?.headers.get("X-Async")).toBe("false");
  expect(response.status).toBe(200);
  expect(response.data).toHaveLength(1);
}

export async function assertAsyncResultPolling() {
  const fetchSpy = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("not ready", { status: 404 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: "deposit_async_001",
        qrCopyPaste: "00020101021226asyncqr",
        qrImageUrl: "https://example.com/qr/deposit_async_001.png",
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );

  const result = await readEulenAsyncResult({
    urlResponse: "https://example.com/eulen-async/deposit-success",
    expiration: "2026-04-18T12:00:00.000Z",
  }, {
    maxAttempts: 2,
    pollDelayMs: 0,
  });

  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(result.attempt).toBe(2);
  expect(result.data.id).toBe("deposit_async_001");
}

export async function assertAsyncResponseResolution() {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({
      response: {
        id: "deposit_async_002",
        qrCopyPaste: "00020101021226asyncqr2",
        qrImageUrl: "https://example.com/qr/deposit_async_002.png",
      },
      async: false,
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }),
  );

  const resolved = await resolveEulenAsyncResponse({
    ok: true,
    status: 202,
    nonce: "nonce_async_001",
    asyncMode: "true",
    headers: {},
    data: {
      async: true,
      urlResponse: "https://example.com/eulen-async/deposit-success",
      expiration: "2026-04-18T12:00:00.000Z",
    },
  }, {
    pollDelayMs: 0,
  });

  expect(resolved.data.async).toBe(false);
  expect(resolved.data.resolvedFromAsync).toBe(true);
  expect(resolved.data.response.id).toBe("deposit_async_002");
  expect(resolved.data.asyncResult.status).toBe(200);
}

export async function assertAsyncBusinessErrorMapping() {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({
      errorMessage: "The split portion exceeds the maximum allowed for this amount.",
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }),
  );

  await expect(resolveEulenAsyncResponse({
    ok: true,
    status: 202,
    nonce: "nonce_async_error",
    asyncMode: "true",
    headers: {},
    data: {
      async: true,
      urlResponse: "https://example.com/eulen-async/deposit-error",
      expiration: "2026-04-18T12:00:00.000Z",
    },
  }, {
    pollDelayMs: 0,
  })).rejects.toMatchObject({
    name: "EulenApiError",
    details: {
      code: "eulen_async_result_failed",
      nonce: "nonce_async_error",
    },
  });
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
  it("requires the mandatory split fields on deposit payloads", assertDepositSplitContract);
  it("fails fast before calling Eulen when split config is missing", assertDepositFailsFastWithoutSplit);
  it("sends deposit requests only when the split config is complete", assertDepositRequestShape);
  it("lists deposits by reconciliation window", assertDepositsListRequestShape);
  it("detects asynchronous response pointers", function assertAsyncPointerDetection() {
    expect(isEulenAsyncResponsePointer({
      async: true,
      urlResponse: "https://example.com/result",
    })).toBe(true);
    expect(isEulenAsyncResponsePointer({ async: false })).toBe(false);
  });
  it("polls asynchronous Eulen result URLs with a bounded retry policy", assertAsyncResultPolling);
  it("normalizes asynchronous Eulen responses into the standard response envelope", assertAsyncResponseResolution);
  it("maps asynchronous Eulen business errors to standardized client errors", assertAsyncBusinessErrorMapping);
});
