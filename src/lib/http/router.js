/**
 * Este arquivo oferece um roteador HTTP minimo para o Worker. Ele foi criado
 * para a fase inicial do MVP, quando precisamos de uma estrutura simples,
 * legivel e facil de expandir sem introduzir frameworks desnecessarios.
 */

import { errorResponse } from "./json.js";

/**
 * Resolve uma requisicao para um mapa simples de rotas.
 * O objetivo e manter o bootstrap pequeno enquanto a aplicacao ainda esta
 * sendo organizada em capacidades maiores.
 *
 * @param {Request} request Requisicao recebida pelo Worker.
 * @param {{env: Record<string, unknown>, ctx: ExecutionContext, logger: {info(message: string, fields?: Record<string, unknown>): void}, routes: Record<string, () => Promise<Response> | Response>}} options
 * Dependencias e tabela de rotas que participam do tratamento.
 * @returns {Promise<Response>} Resposta da rota correspondente ou `404`.
 */
export async function routeRequest(request, options) {
  const { logger, routes } = options;
  const { pathname } = new URL(request.url);

  logger.info("worker.request_received", {
    method: request.method,
    pathname,
  });

  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", 405, {
      message: "Only GET routes are available in the current bootstrap.",
    });
  }

  const handler = routes[pathname];

  if (!handler) {
    return errorResponse("not_found", 404, {
      pathname,
    });
  }

  return await handler();
}
