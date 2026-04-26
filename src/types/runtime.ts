import type { Context } from "hono";
import type { readRuntimeConfig } from "../config/runtime.js";

type RuntimeConfig = Awaited<ReturnType<typeof readRuntimeConfig>>;

export interface WorkerEnv {
  APP_NAME: string;
  APP_ENV: "local" | "test" | "production";
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  DEBOT_REPOSITORY_URL?: string;
  SAGUI_REPOSITORY_URL?: string;
  AUTOIA_REPOSITORY_URL?: string;
  [bindingName: string]: unknown;
}

export interface AppVariables {
  requestId: string;
  requestStartedAt: number;
  runtimeConfig: RuntimeConfig;
}

export type AppBindings = {
  Bindings: WorkerEnv;
  Variables: AppVariables;
};

export type AppContext = Context<AppBindings>;
