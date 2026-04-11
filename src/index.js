/**
 * Este arquivo e o ponto de entrada inicial do Cloudflare Worker do projeto.
 * Ele existe para dar ao repositório uma base executável simples enquanto o
 * MVP ainda esta sendo implementado por partes. A documentacao de convenções
 * de implementação fica em `docs/IMPLEMENTATION-CONVENTIONS.md`.
 */

/**
 * Gera uma resposta JSON consistente para endpoints simples do Worker.
 * A ideia desta função e reduzir repetição e deixar explicito que o projeto
 * comeca com respostas estruturadas desde o bootstrap.
 *
 * @param {unknown} data Conteudo serializável que sera devolvido ao cliente.
 * @param {ResponseInit} [init={}] Parametros opcionais de status e headers.
 * @returns {Response} Resposta HTTP JSON com `content-type` padronizado.
 */
function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

/**
 * Trata o request principal do Worker.
 * Neste momento ele serve como scaffold operacional: responde em `/` e em
 * `/health` para facilitar bootstrap, deploy inicial e smoke checks enquanto
 * Telegram, Eulen, D1, webhook e cron ainda estao sendo implementados.
 *
 * @param {Request} request Requisicao HTTP recebida pelo Worker.
 * @param {Record<string, unknown>} _env Bindings de ambiente do Worker.
 * @returns {Promise<Response>} Resposta HTTP apropriada para a rota recebida.
 */
async function handleRequest(request, _env) {
  const { pathname } = new URL(request.url);

  if (pathname === "/health") {
    return json({
      ok: true,
      service: "depix-mvp",
      status: "bootstrapped",
    });
  }

  if (pathname === "/") {
    return json({
      name: "depix-mvp",
      message: "Cloudflare Worker scaffold for the DePix MVP.",
      nextStep:
        "Implement Telegram, Eulen client, D1 persistence, webhook, and reconciliation.",
      documentation: "docs/IMPLEMENTATION-CONVENTIONS.md",
    });
  }

  return json(
    {
      error: "not_found",
      pathname,
    },
    { status: 404 },
  );
}

export default {
  /**
   * Expõe o handler HTTP do Worker usando o contrato esperado pela Cloudflare.
   * Mantemos esta função curta e comentada para que futuras IAs entendam
   * facilmente onde começar a conectar os próximos módulos do MVP.
   */
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
