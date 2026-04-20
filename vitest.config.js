/**
 * Configuração base do Vitest para o MVP.
 *
 * Este arquivo liga o Vitest ao runtime de Cloudflare Workers usando as
 * exportações reais do pacote instalado. Assim, os testes passam a validar a
 * aplicação dentro do ambiente de Worker desde a fundação do projeto.
 */
import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

const ciFakeBindings = Object.freeze({
  ALPHA_TELEGRAM_BOT_TOKEN: "123456:alpha-ci-fake-token",
  ALPHA_TELEGRAM_WEBHOOK_SECRET: "alpha-ci-fake-webhook-secret",
  ALPHA_EULEN_API_TOKEN: "alpha-ci-fake-eulen-token",
  ALPHA_EULEN_WEBHOOK_SECRET: "alpha-ci-fake-eulen-webhook-secret",
  ALPHA_DEPIX_SPLIT_ADDRESS: "lq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
  ALPHA_DEPIX_SPLIT_FEE: "1.00%",
  BETA_TELEGRAM_BOT_TOKEN: "123456:beta-ci-fake-token",
  BETA_TELEGRAM_WEBHOOK_SECRET: "beta-ci-fake-webhook-secret",
  BETA_EULEN_API_TOKEN: "beta-ci-fake-eulen-token",
  BETA_EULEN_WEBHOOK_SECRET: "beta-ci-fake-eulen-webhook-secret",
  BETA_DEPIX_SPLIT_ADDRESS: "lq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
  BETA_DEPIX_SPLIT_FEE: "1.00%",
});

const workersPoolOptions = {
  wrangler: {
    configPath: "./wrangler.jsonc",
  },
  miniflare: {
    bindings: ciFakeBindings,
  },
};

export default defineConfig({
  plugins: [cloudflareTest(workersPoolOptions)],
  test: {
    include: ["test/**/*.test.js"],
    pool: cloudflarePool(workersPoolOptions),
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
