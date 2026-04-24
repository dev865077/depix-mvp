import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const REGISTRY_KEY = "TENANT_REGISTRY";
const REGISTRY_BINDING = "TENANT_REGISTRY_KV";
const SEED_PATH = "config/tenant-registry.seed.json";

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readWranglerConfig(): Record<string, any> {
  const text = readFileSync("wrangler.jsonc", "utf8")
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  return JSON.parse(text);
}

function expectTenantRegistryNamespace(config: Record<string, any>, id: string) {
  expect(config.kv_namespaces).toContainEqual({
    binding: REGISTRY_BINDING,
    id,
  });
}

describe("tenant registry KV provisioning contract", () => {
  it("declares one tenant registry KV namespace per Worker environment", () => {
    const wrangler = readWranglerConfig();

    expectTenantRegistryNamespace(wrangler, "da9c68eed6a748a3b8cd181550fbd195");
    expectTenantRegistryNamespace(wrangler.env.test, "3e0405c5ed824272bb84b5beea298efa");
    expectTenantRegistryNamespace(wrangler.env.production, "66104d1784c84a3cad8eaaedcecd4caa");
  });

  it("keeps the registry out of inline Worker vars", () => {
    const wrangler = readWranglerConfig();
    const seed = readJsonFile(SEED_PATH);

    expect(wrangler.vars).not.toHaveProperty(REGISTRY_KEY);
    expect(wrangler.env.test.vars).not.toHaveProperty(REGISTRY_KEY);
    expect(wrangler.env.production.vars).not.toHaveProperty(REGISTRY_KEY);
    expect(seed).toHaveProperty("alpha");
    expect(seed).toHaveProperty("beta");
  });

  it("documents the KV key, binding, and seed path", () => {
    const contract = readFileSync("docs/tenant-registry-kv-contract.md", "utf8");
    const seed = readJsonFile(SEED_PATH);

    expect(contract).toContain(REGISTRY_BINDING);
    expect(contract).toContain(`KV key: \`${REGISTRY_KEY}\``);
    expect(contract).toContain(SEED_PATH);
    expect(seed).toHaveProperty("alpha");
    expect(seed).toHaveProperty("beta");
  });
});
