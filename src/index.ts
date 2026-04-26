/**
 * Entrypoint do Cloudflare Worker.
 *
 * Este arquivo exporta a aplicação Hono como handler padrão do Worker. A
 * existência deste entrypoint é uma das provas centrais do BG-01.
 */
import { createApp } from "./app.js";
import type { WorkerEnv } from "./types/runtime";

const app = createApp();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
