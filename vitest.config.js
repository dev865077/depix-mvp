/**
 * Configuração base do Vitest para o MVP.
 *
 * Este arquivo liga o Vitest ao runtime de Cloudflare Workers usando as
 * exportações reais do pacote instalado. Assim, os testes passam a validar a
 * aplicação dentro do ambiente de Worker desde a fundação do projeto.
 */
import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

const workersPoolOptions = {
  wrangler: {
    configPath: "./wrangler.jsonc",
  },
};

export default defineConfig({
  plugins: [cloudflareTest(workersPoolOptions)],
  test: {
    include: ["test/**/*.test.js"],
    pool: cloudflarePool(workersPoolOptions),
  },
});
