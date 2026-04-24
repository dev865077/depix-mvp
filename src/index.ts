/**
 * Entrypoint do Cloudflare Worker.
 *
 * Este arquivo exporta a aplicação Hono como handler padrão do Worker. A
 * existência deste entrypoint é uma das provas centrais do BG-01.
 */
import { createApp } from "./app.js";
import { readRuntimeConfig } from "./config/runtime.js";
import { runScheduledDepositReconciliation } from "./services/scheduled-deposit-reconciliation.js";
import type { WorkerEnv } from "./types/runtime";

const app = createApp();

export async function handleScheduledDepositReconciliation(
  controller: ScheduledController,
  env: WorkerEnv,
): Promise<void> {
  const runtimeConfig = await readRuntimeConfig(env);

  await runScheduledDepositReconciliation({
    env,
    db: env.DB,
    runtimeConfig,
    scheduledTime: controller.scheduledTime,
    cron: controller.cron,
  });
}

export function scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
  ctx.waitUntil(handleScheduledDepositReconciliation(controller, env));
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  scheduled,
} satisfies ExportedHandler<WorkerEnv>;
