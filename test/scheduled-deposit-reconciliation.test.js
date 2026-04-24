/**
 * Testes da reconciliacao agendada de depositos pendentes.
 */
// @vitest-pool cloudflare
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readRuntimeConfig } from "../src/config/runtime.js";
import { getDatabase } from "../src/db/client.js";
import { listDepositEventsByDepositEntryId } from "../src/db/repositories/deposit-events-repository.js";
import {
  claimPendingTelegramDepositForScheduledReconciliation,
  createDeposit,
  getDepositByDepositEntryId,
  listPendingTelegramDepositsForScheduledReconciliation,
  releaseScheduledDepositReconciliationClaim,
  updateDepositByDepositEntryId,
} from "../src/db/repositories/deposits-repository.js";
import { createOrder, getOrderById } from "../src/db/repositories/orders-repository.js";
import { runScheduledDepositReconciliation } from "../src/services/scheduled-deposit-reconciliation.js";
import worker, { scheduled } from "../src/index.ts";
import { resetDatabaseSchema } from "./helpers/database-schema.js";

const BASE_TIME = "2026-04-21T10:00:00.000Z";
const TENANT_REGISTRY = JSON.stringify({
  alpha: {
    displayName: "Alpha",
    eulenPartnerId: "partner-alpha",
    splitConfigBindings: {
      depixSplitAddress: "ALPHA_DEPIX_SPLIT_ADDRESS",
      splitFee: "ALPHA_DEPIX_SPLIT_FEE",
    },
    secretBindings: {
      telegramBotToken: "ALPHA_TELEGRAM_BOT_TOKEN",
      telegramWebhookSecret: "ALPHA_TELEGRAM_WEBHOOK_SECRET",
      eulenApiToken: "ALPHA_EULEN_API_TOKEN",
      eulenWebhookSecret: "ALPHA_EULEN_WEBHOOK_SECRET",
    },
  },
  beta: {
    displayName: "Beta",
    eulenPartnerId: "partner-beta",
    splitConfigBindings: {
      depixSplitAddress: "BETA_DEPIX_SPLIT_ADDRESS",
      splitFee: "BETA_DEPIX_SPLIT_FEE",
    },
    secretBindings: {
      telegramBotToken: "BETA_TELEGRAM_BOT_TOKEN",
      telegramWebhookSecret: "BETA_TELEGRAM_WEBHOOK_SECRET",
      eulenApiToken: "BETA_EULEN_API_TOKEN",
      eulenWebhookSecret: "BETA_EULEN_WEBHOOK_SECRET",
    },
  },
});

function createTenantRegistryKv(registry = TENANT_REGISTRY) {
  return {
    async get(key) {
      return key === "TENANT_REGISTRY" ? registry : null;
    },
  };
}

function createWorkerEnv(overrides = {}) {
  const tenantRegistry = Object.prototype.hasOwnProperty.call(overrides, "TENANT_REGISTRY")
    ? overrides.TENANT_REGISTRY
    : TENANT_REGISTRY;
  const hasTenantRegistryKvOverride = Object.prototype.hasOwnProperty.call(overrides, "TENANT_REGISTRY_KV");
  const {
    TENANT_REGISTRY: _tenantRegistry,
    TENANT_REGISTRY_KV: tenantRegistryKv,
    ...workerOverrides
  } = overrides;

  return {
    DB: env.DB,
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    EULEN_API_BASE_URL: "https://depix.eulen.app/api",
    EULEN_API_TIMEOUT_MS: "10000",
    ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION: "true",
    TENANT_REGISTRY_KV: hasTenantRegistryKvOverride ? tenantRegistryKv : createTenantRegistryKv(tenantRegistry),
    ALPHA_TELEGRAM_BOT_TOKEN: "alpha-bot-token",
    ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-telegram-secret",
    ALPHA_EULEN_API_TOKEN: "alpha-eulen-token",
    ALPHA_EULEN_WEBHOOK_SECRET: "alpha-eulen-secret",
    ALPHA_DEPIX_SPLIT_ADDRESS: "split-address-alpha",
    ALPHA_DEPIX_SPLIT_FEE: "12.50%",
    BETA_TELEGRAM_BOT_TOKEN: "beta-bot-token",
    BETA_TELEGRAM_WEBHOOK_SECRET: "beta-telegram-secret",
    BETA_EULEN_API_TOKEN: "beta-eulen-token",
    BETA_EULEN_WEBHOOK_SECRET: "beta-eulen-secret",
    BETA_DEPIX_SPLIT_ADDRESS: "split-address-beta",
    BETA_DEPIX_SPLIT_FEE: "15.00%",
    ...workerOverrides,
  };
}

async function seedDepositAggregate(input) {
  const db = getDatabase(env);
  const tenantId = input.tenantId ?? "alpha";
  const orderId = input.orderId;
  const depositEntryId = input.depositEntryId;

  await createOrder(db, {
    tenantId,
    orderId,
    userId: input.userId ?? `${tenantId}_telegram_user_${orderId}`,
    channel: input.channel ?? "telegram",
    productType: "depix",
    amountInCents: 12345,
    walletAddress: "depix_wallet_alpha",
    currentStep: input.currentStep ?? "awaiting_payment",
    status: input.status ?? "pending",
    splitAddress: "split_wallet_alpha",
    splitFee: "0.50",
    telegramChatId: input.telegramChatId ?? `${tenantId}_telegram_chat_${orderId}`,
  });

  await createDeposit(db, {
    tenantId,
    depositEntryId,
    qrId: input.qrId ?? `qr_${depositEntryId}`,
    orderId,
    nonce: input.nonce ?? `nonce_${depositEntryId}`,
    qrCopyPaste: `0002010102122688${depositEntryId}`,
    qrImageUrl: `https://example.com/qr/${depositEntryId}.png`,
    externalStatus: input.externalStatus ?? "pending",
    expiration: "2026-04-21T12:00:00Z",
  });

  if (input.createdAt || input.updatedAt) {
    await db.prepare(`
      UPDATE deposits
      SET created_at = ?, updated_at = ?
      WHERE tenant_id = ? AND deposit_entry_id = ?
    `).bind(
      input.createdAt ?? input.updatedAt,
      input.updatedAt ?? input.createdAt,
      tenantId,
      depositEntryId,
    ).run();
  }

  return { db, tenantId, orderId, depositEntryId };
}

function createRuntime(overrides = {}) {
  return readRuntimeConfig(createWorkerEnv(overrides));
}

async function runScheduler(overrides = {}) {
  const workerEnv = createWorkerEnv(overrides.env);

  return runScheduledDepositReconciliation({
    env: workerEnv,
    db: workerEnv.DB,
    runtimeConfig: await readRuntimeConfig(workerEnv),
    scheduledTime: overrides.scheduledTime ?? BASE_TIME,
    cron: overrides.cron ?? "*/15 * * * *",
    requestId: overrides.requestId ?? "scheduled-test",
  });
}

async function countDepositEvents(depositEntryId, tenantId = "alpha") {
  const events = await listDepositEventsByDepositEntryId(env.DB, tenantId, depositEntryId);

  return events.length;
}

async function countScheduledClaims(depositEntryId, tenantId = "alpha") {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM scheduled_deposit_reconciliation_claims
    WHERE tenant_id = ? AND deposit_entry_id = ?
  `).bind(tenantId, depositEntryId).first();

  return Number(result?.total ?? 0);
}

function mockDepositStatus(fetchStatuses) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async function mockScheduledFetch(input, init) {
    const url = String(input);

    if (url.startsWith("https://depix.eulen.app/api/deposit-status")) {
      const depositEntryId = new URL(url).searchParams.get("id");
      const status = fetchStatuses[depositEntryId] ?? "pending";

      if (status === "throw") {
        return new Response(JSON.stringify({ error: "synthetic upstream failure" }), { status: 503 });
      }

      return new Response(JSON.stringify({
        response: {
          qrId: `qr_${depositEntryId}`,
          status,
          expiration: "2026-04-21T12:00:00Z",
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (url.startsWith("https://api.telegram.org/bot")) {
      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 901,
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url} ${String(init?.body ?? "")}`);
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
}

afterEach(function restoreScheduledMocks() {
  vi.restoreAllMocks();
});

describe("scheduled deposit reconciliation", () => {
  it("keeps the Worker module fetchable and schedules work through ctx.waitUntil", async function assertScheduledEntrypoint() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();

    const waitUntil = vi.fn();
    const executionContext = {
      waitUntil,
      passThroughOnException: vi.fn(),
    };
    const workerEnv = createWorkerEnv({
      ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION: "false",
    });

    expect(worker.fetch).toBeTypeOf("function");
    expect(worker.scheduled).toBe(scheduled);

    expect(() => scheduled(
      {
        cron: "*/15 * * * *",
        scheduledTime: Date.parse(BASE_TIME),
      },
      workerEnv,
      executionContext,
    )).not.toThrow();

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];

    const healthResponse = await worker.fetch(
      new Request("https://depix.local/health"),
      workerEnv,
      executionContext,
    );
    const healthPayload = await healthResponse.json();

    expect(healthResponse.status).toBe(200);
    expect(healthPayload?.configuration?.operations?.scheduledDepositReconciliation?.state).toBe("disabled");
  });

  it("skips without outbound work when the kill switch is disabled", async function assertDisabledScheduler() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();
    await seedDepositAggregate({
      orderId: "order_disabled_001",
      depositEntryId: "deposit_disabled_001",
      updatedAt: "2026-04-21T09:30:00.000Z",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runScheduler({
      env: {
        ENABLE_SCHEDULED_DEPOSIT_RECONCILIATION: "false",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      state: "disabled",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await countDepositEvents("deposit_disabled_001")).toBe(0);
  });

  it("selects only eligible Telegram pending deposits inside the window and caps each tenant", async function assertBoundedSelection() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();

    for (let index = 1; index <= 7; index += 1) {
      await seedDepositAggregate({
        orderId: `order_cap_${index}`,
        depositEntryId: `deposit_cap_${index}`,
        updatedAt: `2026-04-21T08:3${index}:00.000Z`,
      });
    }

    await seedDepositAggregate({
      orderId: "order_old",
      depositEntryId: "deposit_old",
      updatedAt: "2026-04-21T07:30:00.000Z",
    });
    await seedDepositAggregate({
      orderId: "order_not_waiting",
      depositEntryId: "deposit_not_waiting",
      currentStep: "completed",
      status: "paid",
      updatedAt: "2026-04-21T09:10:00.000Z",
    });
    await seedDepositAggregate({
      orderId: "order_beta",
      depositEntryId: "deposit_beta",
      tenantId: "beta",
      updatedAt: "2026-04-21T09:20:00.000Z",
    });

    const eligibleAlpha = await listPendingTelegramDepositsForScheduledReconciliation(
      env.DB,
      "alpha",
      "2026-04-21T08:00:00.000Z",
      5,
    );

    expect(eligibleAlpha.map((deposit) => deposit.depositEntryId)).toEqual([
      "deposit_cap_1",
      "deposit_cap_2",
      "deposit_cap_3",
      "deposit_cap_4",
      "deposit_cap_5",
    ]);

    const fetchSpy = mockDepositStatus({});
    const result = await runScheduler();

    expect(result).toMatchObject({
      skipped: false,
      tenants: 2,
      selected: 6,
      processed: 6,
      failed: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(await countDepositEvents("deposit_cap_1")).toBe(1);
    expect(await countDepositEvents("deposit_cap_6")).toBe(0);
    expect(await countDepositEvents("deposit_old")).toBe(0);
    expect(await countDepositEvents("deposit_not_waiting")).toBe(0);
    expect(await countDepositEvents("deposit_beta", "beta")).toBe(1);
  });

  it("reconciles successful deposits, notifies Telegram, and isolates per-deposit failures", async function assertSuccessAndIsolation() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();
    await seedDepositAggregate({
      orderId: "order_success",
      depositEntryId: "deposit_success",
      updatedAt: "2026-04-21T09:00:00.000Z",
    });
    await seedDepositAggregate({
      orderId: "order_failure",
      depositEntryId: "deposit_failure",
      updatedAt: "2026-04-21T09:01:00.000Z",
    });

    const fetchSpy = mockDepositStatus({
      deposit_success: "depix_sent",
      deposit_failure: "throw",
    });
    const result = await runScheduler();
    const successDeposit = await getDepositByDepositEntryId(env.DB, "alpha", "deposit_success");
    const successOrder = await getOrderById(env.DB, "alpha", "order_success");
    const failureOrder = await getOrderById(env.DB, "alpha", "order_failure");

    expect(result).toMatchObject({
      selected: 2,
      processed: 1,
      failed: 1,
      notificationDelivered: 1,
    });
    expect(successDeposit?.externalStatus).toBe("depix_sent");
    expect(successOrder?.status).toBe("paid");
    expect(successOrder?.currentStep).toBe("completed");
    expect(failureOrder?.status).toBe("pending");
    expect((await getDepositByDepositEntryId(env.DB, "alpha", "deposit_failure"))?.externalStatus).toBe("pending");
    expect(await countDepositEvents("deposit_success")).toBe(1);
    expect(await countDepositEvents("deposit_failure")).toBe(0);
    expect(await countScheduledClaims("deposit_success")).toBe(0);
    expect(await countScheduledClaims("deposit_failure")).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("continues other tenants when one tenant dependency is missing", async function assertTenantFailureIsolation() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();
    await seedDepositAggregate({
      orderId: "order_alpha_tenant_ok",
      depositEntryId: "deposit_alpha_tenant_ok",
      updatedAt: "2026-04-21T09:20:00.000Z",
    });
    await seedDepositAggregate({
      tenantId: "beta",
      orderId: "order_beta_tenant_fail",
      depositEntryId: "deposit_beta_tenant_fail",
      updatedAt: "2026-04-21T09:21:00.000Z",
    });

    const fetchSpy = mockDepositStatus({
      deposit_alpha_tenant_ok: "pending",
    });
    const result = await runScheduler({
      env: {
        BETA_EULEN_API_TOKEN: undefined,
      },
    });

    expect(result).toMatchObject({
      tenants: 2,
      selected: 1,
      processed: 1,
      failed: 1,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await countDepositEvents("deposit_alpha_tenant_ok")).toBe(1);
    expect(await countDepositEvents("deposit_beta_tenant_fail", "beta")).toBe(0);
  });

  it("prevents overlapping runs from processing and notifying the same deposit twice", async function assertOverlapClaim() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();
    await seedDepositAggregate({
      orderId: "order_overlap",
      depositEntryId: "deposit_overlap",
      updatedAt: "2026-04-21T09:25:00.000Z",
    });

    const remoteStarted = createDeferred();
    const releaseRemote = createDeferred();
    let eulenCalls = 0;
    let telegramCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async function mockOverlappingFetch(input) {
      const url = String(input);

      if (url.startsWith("https://depix.eulen.app/api/deposit-status")) {
        eulenCalls += 1;
        remoteStarted.resolve();
        await releaseRemote.promise;

        return new Response(JSON.stringify({
          response: {
            qrId: "qr_deposit_overlap",
            status: "depix_sent",
            expiration: "2026-04-21T12:00:00Z",
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.startsWith("https://api.telegram.org/bot")) {
        telegramCalls += 1;

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 902,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const firstRun = runScheduler({ requestId: "scheduled-overlap-1" });

    await remoteStarted.promise;

    const secondResult = await runScheduler({ requestId: "scheduled-overlap-2" });

    releaseRemote.resolve();

    const firstResult = await firstRun;
    const overlapDeposit = await getDepositByDepositEntryId(env.DB, "alpha", "deposit_overlap");
    const overlapOrder = await getOrderById(env.DB, "alpha", "order_overlap");

    expect(secondResult).toMatchObject({
      selected: 0,
      processed: 0,
      failed: 0,
    });
    expect(firstResult).toMatchObject({
      selected: 1,
      processed: 1,
      failed: 0,
      notificationDelivered: 1,
    });
    expect(overlapDeposit?.externalStatus).toBe("depix_sent");
    expect(overlapOrder?.status).toBe("paid");
    expect(await countDepositEvents("deposit_overlap")).toBe(1);
    expect(await countScheduledClaims("deposit_overlap")).toBe(0);
    expect(eulenCalls).toBe(1);
    expect(telegramCalls).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the scheduled claim outside the deposit business status and never clobbers newer truth on release", async function assertClaimIsolation() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();
    await seedDepositAggregate({
      orderId: "order_claim_isolation",
      depositEntryId: "deposit_claim_isolation",
      updatedAt: "2026-04-21T09:22:00.000Z",
    });

    const depositBeforeClaim = await getDepositByDepositEntryId(env.DB, "alpha", "deposit_claim_isolation");

    expect(await claimPendingTelegramDepositForScheduledReconciliation(
      env.DB,
      "alpha",
      "deposit_claim_isolation",
      depositBeforeClaim?.externalStatus ?? "pending",
      depositBeforeClaim?.updatedAt ?? "2026-04-21T09:22:00.000Z",
      "2026-04-21T10:01:00.000Z",
      "2026-04-21T09:51:00.000Z",
    )).toBe(true);

    const depositDuringClaim = await getDepositByDepositEntryId(env.DB, "alpha", "deposit_claim_isolation");

    expect(depositDuringClaim?.externalStatus).toBe("pending");
    expect(await countScheduledClaims("deposit_claim_isolation")).toBe(1);

    await updateDepositByDepositEntryId(env.DB, "alpha", "deposit_claim_isolation", {
      externalStatus: "depix_sent",
    });
    await releaseScheduledDepositReconciliationClaim(env.DB, "alpha", "deposit_claim_isolation");

    const depositAfterRelease = await getDepositByDepositEntryId(env.DB, "alpha", "deposit_claim_isolation");

    expect(depositAfterRelease?.externalStatus).toBe("depix_sent");
    expect(await countScheduledClaims("deposit_claim_isolation")).toBe(0);
  });

  it("lets concurrent claim contenders lose cleanly without a D1 conflict or duplicate processing state", async function assertConcurrentClaimContention() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();
    await seedDepositAggregate({
      orderId: "order_claim_race",
      depositEntryId: "deposit_claim_race",
      updatedAt: "2026-04-21T09:24:00.000Z",
    });

    const depositBeforeClaim = await getDepositByDepositEntryId(env.DB, "alpha", "deposit_claim_race");
    const claimArgs = [
      env.DB,
      "alpha",
      "deposit_claim_race",
      depositBeforeClaim?.externalStatus ?? "pending",
      depositBeforeClaim?.updatedAt ?? "2026-04-21T09:24:00.000Z",
      "2026-04-21T10:02:00.000Z",
      "2026-04-21T09:52:00.000Z",
    ];

    const results = await Promise.allSettled([
      claimPendingTelegramDepositForScheduledReconciliation(...claimArgs),
      claimPendingTelegramDepositForScheduledReconciliation(...claimArgs),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(results.map((result) => result.value).sort()).toEqual([false, true]);
    expect(await countScheduledClaims("deposit_claim_race")).toBe(1);
    expect((await getDepositByDepositEntryId(env.DB, "alpha", "deposit_claim_race"))?.externalStatus).toBe("pending");
  });

  it("keeps repeated pending rechecks idempotent", async function assertPendingRecheckIdempotency() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await resetDatabaseSchema();
    await seedDepositAggregate({
      orderId: "order_idempotent",
      depositEntryId: "deposit_idempotent",
      updatedAt: "2026-04-21T09:15:00.000Z",
    });

    mockDepositStatus({
      deposit_idempotent: "pending",
    });

    const firstResult = await runScheduler({ requestId: "scheduled-first" });
    const secondResult = await runScheduler({ requestId: "scheduled-second" });

    expect(firstResult).toMatchObject({
      processed: 1,
      duplicates: 0,
      failed: 0,
    });
    expect(secondResult).toMatchObject({
      processed: 1,
      duplicates: 1,
      failed: 0,
    });
    expect(await countDepositEvents("deposit_idempotent")).toBe(1);
  });
});

describe("scheduled deposit reconciliation runtime readiness", () => {
  it("exposes ready state only when the scheduled flag and D1 are configured", async function assertRuntimeReadyState() {
    const runtimeConfig = await createRuntime();

    expect(runtimeConfig.operations.scheduledDepositReconciliation.state).toBe("ready");
    expect(runtimeConfig.operations.scheduledDepositReconciliation.ready).toBe(true);
  });
});
