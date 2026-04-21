/**
 * Entrypoint do Cloudflare Worker.
 *
 * Este arquivo exporta a aplicação Hono como handler padrão do Worker. A
 * existência deste entrypoint é uma das provas centrais do BG-01.
 */
import { createApp } from "./app.js";

const app = createApp();

export default app;
