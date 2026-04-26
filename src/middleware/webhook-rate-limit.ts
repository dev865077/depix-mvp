import type { MiddlewareHandler } from "hono";

import { jsonError } from "../lib/http.js";
import { log } from "../lib/logger.js";
import type { AppBindings, AppContext, TenantConfig } from "../types/runtime";

export type WebhookRateLimitScope = "telegram_webhook" | "eulen_deposit_webhook";

export const WEBHOOK_RATE_LIMIT_POLICY = {
  limit: 60,
  windowMs: 60_000,
} as const;

const ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK = "ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK";

type RateLimitBucket = {
  count: number;
  resetAtMs: number;
};

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAtMs: number;
};

const webhookRateLimitBuckets = new Map<string, RateLimitBucket>();

function deleteExpiredWebhookRateLimitBuckets(nowMs: number): void {
  for (const [key, bucket] of webhookRateLimitBuckets.entries()) {
    if (bucket.resetAtMs <= nowMs) {
      webhookRateLimitBuckets.delete(key);
    }
  }
}

function normalizeClientIp(rawValue: string | undefined): string {
  return rawValue?.split(",")[0]?.trim() || "unknown";
}

export function getWebhookRateLimitClientIp(c: AppContext): string {
  return normalizeClientIp(
    c.req.header("cf-connecting-ip")
      ?? c.req.header("x-forwarded-for")
      ?? c.req.header("x-real-ip"),
  );
}

export function buildWebhookRateLimitKey(input: {
  scope: WebhookRateLimitScope;
  tenantId: TenantConfig["tenantId"];
  clientIp: string;
}): string {
  return `${input.scope}:${input.tenantId}:${input.clientIp}`;
}

export function consumeWebhookRateLimit(input: {
  scope: WebhookRateLimitScope;
  tenantId: TenantConfig["tenantId"];
  clientIp: string;
  nowMs?: number;
}): RateLimitResult {
  const nowMs = input.nowMs ?? Date.now();
  const key = buildWebhookRateLimitKey(input);

  deleteExpiredWebhookRateLimitBuckets(nowMs);

  const currentBucket = webhookRateLimitBuckets.get(key);
  const activeBucket = currentBucket && currentBucket.resetAtMs > nowMs
    ? currentBucket
    : {
      count: 0,
      resetAtMs: nowMs + WEBHOOK_RATE_LIMIT_POLICY.windowMs,
    };

  if (activeBucket.count >= WEBHOOK_RATE_LIMIT_POLICY.limit) {
    webhookRateLimitBuckets.set(key, activeBucket);

    return {
      allowed: false,
      limit: WEBHOOK_RATE_LIMIT_POLICY.limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((activeBucket.resetAtMs - nowMs) / 1000)),
      resetAtMs: activeBucket.resetAtMs,
    };
  }

  const updatedBucket = {
    ...activeBucket,
    count: activeBucket.count + 1,
  };
  webhookRateLimitBuckets.set(key, updatedBucket);

  return {
    allowed: true,
    limit: WEBHOOK_RATE_LIMIT_POLICY.limit,
    remaining: Math.max(0, WEBHOOK_RATE_LIMIT_POLICY.limit - updatedBucket.count),
    retryAfterSeconds: 0,
    resetAtMs: updatedBucket.resetAtMs,
  };
}

export function resetWebhookRateLimitStateForTests(): void {
  webhookRateLimitBuckets.clear();
}

export function getWebhookRateLimitBucketCountForTests(): number {
  return webhookRateLimitBuckets.size;
}

function isLocalWebhookRateLimitFallbackEnabled(c: AppContext): boolean {
  return c.env[ENABLE_LOCAL_WEBHOOK_RATE_LIMIT_FALLBACK] === "true";
}

export function createWebhookRateLimitMiddleware(scope: WebhookRateLimitScope): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!isLocalWebhookRateLimitFallbackEnabled(c)) {
      await next();
      return;
    }

    const tenant = c.get("tenant");

    if (!tenant) {
      await next();
      return;
    }

    const clientIp = getWebhookRateLimitClientIp(c);
    const rateLimit = consumeWebhookRateLimit({
      scope,
      tenantId: tenant.tenantId,
      clientIp,
    });

    c.header("X-RateLimit-Limit", String(rateLimit.limit));
    c.header("X-RateLimit-Remaining", String(rateLimit.remaining));

    if (rateLimit.allowed) {
      await next();
      return;
    }

    c.header("Retry-After", String(rateLimit.retryAfterSeconds));
    c.header("X-RateLimit-Reset", String(Math.ceil(rateLimit.resetAtMs / 1000)));

    log(c.get("runtimeConfig"), {
      level: "warn",
      message: "webhook.rate_limit_exceeded",
      tenantId: tenant.tenantId,
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: 429,
      details: {
        scope,
        clientIp,
        limit: rateLimit.limit,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
    });

    return jsonError(
      c,
      429,
      "rate_limit_exceeded",
      "Webhook rate limit exceeded. Try again later.",
      {
        scope,
        limit: rateLimit.limit,
        windowSeconds: Math.ceil(WEBHOOK_RATE_LIMIT_POLICY.windowMs / 1000),
      },
    );
  };
}
