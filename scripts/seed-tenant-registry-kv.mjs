import { spawnSync } from "node:child_process";

const REGISTRY_KEY = "TENANT_REGISTRY";
const BINDING = "TENANT_REGISTRY_KV";
const SEED_PATH = "config/tenant-registry.seed.json";

const environments = [
  { name: "local", args: [] },
  { name: "test", args: ["--env", "test"] },
  { name: "production", args: ["--env", "production"] },
];

for (const environment of environments) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "kv",
      "key",
      "put",
      REGISTRY_KEY,
      "--path",
      SEED_PATH,
      "--binding",
      BINDING,
      "--remote",
      ...environment.args,
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to seed tenant registry KV for ${environment.name}.`);
  }
}
