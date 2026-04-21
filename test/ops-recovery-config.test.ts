import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

type WranglerSecretBinding = {
  binding?: string;
  secret_name?: string;
};

type WranglerEnvironment = {
  vars?: Record<string, string>;
  secrets_store_secrets?: WranglerSecretBinding[];
};

type WranglerConfig = {
  env?: Record<string, WranglerEnvironment>;
};

const OPS_RECOVERY_ENVS = ["test", "production"] as const;

function readWranglerConfig(): WranglerConfig {
  const parsedConfig = parseConfigFileTextToJson("wrangler.jsonc", readFileSync("wrangler.jsonc", "utf8"));

  if (parsedConfig.error) {
    throw new Error(`Failed to parse wrangler.jsonc: ${String(parsedConfig.error.messageText)}`);
  }

  return parsedConfig.config as WranglerConfig;
}

function findSecretBinding(environment: WranglerEnvironment, binding: string): WranglerSecretBinding | undefined {
  return environment.secrets_store_secrets?.find((secretBinding) => secretBinding.binding === binding);
}

describe("ops recovery environment config", () => {
  it("enables recheck and deposits fallback behind the global bearer secret in test and production", () => {
    const config = readWranglerConfig();

    for (const environmentName of OPS_RECOVERY_ENVS) {
      const environment = config.env?.[environmentName];

      expect(environment, `${environmentName} env must exist`).toBeDefined();
      expect(environment?.vars?.ENABLE_OPS_DEPOSIT_RECHECK).toBe("true");
      expect(environment?.vars?.ENABLE_OPS_DEPOSITS_FALLBACK).toBe("true");

      const opsBearerBinding = findSecretBinding(environment ?? {}, "OPS_ROUTE_BEARER_TOKEN");

      expect(opsBearerBinding?.secret_name).toBe(`${environmentName}-ops-route-bearer-token`);
    }
  });
});
