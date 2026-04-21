const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TelegramOrderNonceInput = {
  tenantId: string;
  orderId: string;
};

function normalizeNoncePart(value: string, field: string): string {
  const normalizedValue = String(value ?? "").trim();

  if (normalizedValue.length === 0) {
    throw new Error(`Telegram order deposit nonce requires ${field}.`);
  }

  return normalizedValue;
}

function extractUuidFromOrderId(orderId: string): string | null {
  const normalizedOrderId = normalizeNoncePart(orderId, "orderId").toLowerCase();
  const candidate = normalizedOrderId.startsWith("order_")
    ? normalizedOrderId.slice("order_".length)
    : normalizedOrderId;

  return UUID_PATTERN.test(candidate) ? candidate : null;
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

function writeUint32(bytes: number[], offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function bytesToUuid(bytes: number[]): string {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function buildDeterministicUuid(input: string): string {
  const bytes = new Array(16).fill(0);
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];

  seeds.forEach((seed, index) => {
    writeUint32(bytes, index * 4, fnv1a32(`${input}:${index}`, seed));
  });

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}

/**
 * Builds the stable idempotency nonce accepted by Eulen's `X-Nonce` contract.
 *
 * Runtime order ids are already generated as `order_<uuid>`, so the canonical
 * path reuses that UUID directly. A deterministic UUID fallback keeps legacy
 * tests and old rows stable without reintroducing non-UUID nonce values.
 */
export function createTelegramOrderDepositNonce(input: TelegramOrderNonceInput): string {
  const tenantId = normalizeNoncePart(input.tenantId, "tenantId");
  const orderId = normalizeNoncePart(input.orderId, "orderId");
  const embeddedOrderUuid = extractUuidFromOrderId(orderId);

  if (embeddedOrderUuid) {
    return embeddedOrderUuid;
  }

  return buildDeterministicUuid(`telegram-order:${tenantId}:${orderId}`);
}

