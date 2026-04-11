/**
 * Este arquivo monta a aplicacao HTTP principal do Worker. Ele concentra as
 * rotas iniciais, conecta utilitarios compartilhados e deixa explicito como a
 * fundacao da `S1` se encaixa no runtime do projeto. Para contexto maior, ler
 * `docs/ARCHITECTURE-FOUNDATION.md`.
 */

import { errorResponse, jsonResponse } from "./lib/http/json.js";
import { routeRequest } from "./lib/http/router.js";
import { hasDatabaseBinding } from "./lib/data/d1.js";
import {
  CONVERSATION_STATES,
  CONVERSATION_TRANSITIONS,
} from "./lib/telegram/conversation-states.js";
import { advanceConversation } from "./lib/telegram/flow.js";
import { getSchemaOverview } from "./lib/data/schema.js";
import { createLogger } from "./lib/observability/logger.js";

/**
 * Monta o objeto de aplicacao do Worker.
 * A funcao existe para encapsular dependencias e deixar o ponto de entrada do
 * runtime enxuto, o que facilita testes e evolucoes posteriores.
 *
 * @returns {{fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response>}}
 * Aplicacao pronta para responder ao evento `fetch` da Cloudflare.
 */
export function createApp() {
  return {
    /**
     * Roteia requests HTTP para os handlers conhecidos do bootstrap atual.
     * Enquanto Telegram, Eulen e webhook ainda nao estao ligados ao mundo
     * externo, esta funcao serve como base observavel para evolucao da `S1`.
     *
     * @param {Request} request Requisicao recebida pelo Worker.
     * @param {Record<string, unknown>} env Bindings e secrets do ambiente.
     * @param {ExecutionContext} ctx Contexto de execucao da Cloudflare.
     * @returns {Promise<Response>} Resposta HTTP apropriada para a rota.
     */
    async fetch(request, env, ctx) {
      const logger = createLogger({
        requestId: request.headers.get("cf-ray") || crypto.randomUUID(),
        path: new URL(request.url).pathname,
      });

      try {
        return await routeRequest(request, {
          env,
          ctx,
          logger,
          routes: {
            "/": async () =>
              jsonResponse({
                name: "depix-mvp",
                stage: "s1-foundation",
                message:
                  "Worker modular bootstrap for the Telegram + DePix MVP.",
                documentation: [
                  "docs/ARCHITECTURE-FOUNDATION.md",
                  "docs/IMPLEMENTATION-CONVENTIONS.md",
                ],
              }),
            "/health": async () =>
              jsonResponse({
                ok: true,
                service: "depix-mvp",
                stage: "s1-foundation",
                dependencies: {
                  d1Configured: hasDatabaseBinding(env),
                  telegramFlowModeled: true,
                  initialSchemaModeled: true,
                },
              }),
            "/telegram/states": async () =>
              jsonResponse({
                states: CONVERSATION_STATES,
                transitions: CONVERSATION_TRANSITIONS,
              }),
            "/telegram/preview": async () =>
              jsonResponse(buildTelegramPreview(request)),
            "/data/schema": async () =>
              jsonResponse({
                overview: getSchemaOverview(),
                migrationFile: "migrations/0001_initial_schema.sql",
              }),
          },
        });
      } catch (error) {
        logger.error("worker.request_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage:
            error instanceof Error ? error.message : "Unknown error value",
        });

        return errorResponse("internal_error", 500, {
          message: "Unexpected error while handling request.",
        });
      }
    },
  };
}

/**
 * Gera um preview do fluxo da conversa a partir de query params.
 * Esse helper existe para tornar a maquina de conversa observavel durante a
 * `S1`, sem depender ainda do adaptador real do Telegram.
 *
 * @param {Request} request Requisicao atual recebida pelo Worker.
 * @returns {{input: string, before: {state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null}, after: {state: string, productType: string | null, amountInCents: number | null, depixAddress: string | null}, accepted: boolean, prompt: string, validationError: string | null}}
 * Resultado da simulacao de um passo do fluxo conversacional.
 */
function buildTelegramPreview(request) {
  const url = new URL(request.url);
  const before = {
    state: url.searchParams.get("state") || CONVERSATION_STATES.IDLE,
    productType: url.searchParams.get("productType"),
    amountInCents: parseNullableInteger(url.searchParams.get("amountInCents")),
    depixAddress: url.searchParams.get("depixAddress"),
  };
  const input = url.searchParams.get("input") || "start";
  const result = advanceConversation(before, input);

  return {
    input,
    before,
    after: result.context,
    accepted: result.accepted,
    prompt: result.prompt,
    validationError: result.validationError,
  };
}

/**
 * Converte um texto opcional em inteiro ou `null`.
 * O helper evita duplicacao ao montar previews e outros handlers de bootstrap.
 *
 * @param {string | null} value Texto vindo da URL.
 * @returns {number | null} Numero inteiro ou `null` quando ausente/invalido.
 */
function parseNullableInteger(value) {
  if (value === null || value === "") {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);

  return Number.isNaN(parsedValue) ? null : parsedValue;
}
