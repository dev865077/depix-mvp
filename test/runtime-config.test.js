/**
 * Testes da leitura de configuracao minima do Worker de produto.
 */
import { describe, expect, it } from "vitest";

import { assertRequiredString, readRuntimeConfig } from "../src/config/runtime.js";

function createRuntimeEnv(overrides = {}) {
  return {
    APP_NAME: "depix-mvp",
    APP_ENV: "local",
    LOG_LEVEL: "debug",
    ...overrides,
  };
}

describe("runtime config", () => {
  it("reads the product shell runtime config with repository pointers", async () => {
    const runtimeConfig = await readRuntimeConfig(createRuntimeEnv());

    expect(runtimeConfig).toEqual({
      appName: "depix-mvp",
      environment: "local",
      logLevel: "debug",
      externalSystems: {
        debotRepositoryUrl: "https://github.com/dev865077/DeBot",
        saguiRepositoryUrl: "https://github.com/dev865077/Sagui",
        autoIaRepositoryUrl: "https://github.com/dev865077/AutoIA-Github",
      },
    });
  });

  it("accepts explicit repository pointer overrides", async () => {
    const runtimeConfig = await readRuntimeConfig(createRuntimeEnv({
      DEBOT_REPOSITORY_URL: "https://example.test/debot",
      SAGUI_REPOSITORY_URL: "https://example.test/sagui",
      AUTOIA_REPOSITORY_URL: "https://example.test/autoia",
    }));

    expect(runtimeConfig.externalSystems).toEqual({
      debotRepositoryUrl: "https://example.test/debot",
      saguiRepositoryUrl: "https://example.test/sagui",
      autoIaRepositoryUrl: "https://example.test/autoia",
    });
  });

  it("rejects missing required runtime bindings", () => {
    expect(() => assertRequiredString(undefined, "APP_NAME")).toThrow("Missing required binding: APP_NAME");
    expect(() => assertRequiredString(" ", "APP_NAME")).toThrow("Missing required binding: APP_NAME");
  });

  it("rejects unsupported environment and log level values", async () => {
    await expect(readRuntimeConfig(createRuntimeEnv({ APP_ENV: "staging" })))
      .rejects.toThrow("Invalid APP_ENV value: staging");
    await expect(readRuntimeConfig(createRuntimeEnv({ LOG_LEVEL: "trace" })))
      .rejects.toThrow("Invalid LOG_LEVEL value: trace");
  });
});
