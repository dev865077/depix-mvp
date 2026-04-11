/**
 * Este arquivo concentra respostas HTTP padronizadas do Worker. Ele existe
 * para evitar repeticao, manter respostas consistentes e facilitar a leitura
 * dos handlers sem misturar regras de negocio com detalhes de serializacao.
 */

/**
 * Cria uma resposta JSON com `content-type` padronizado.
 * A funcao centraliza a serializacao para que o restante do codigo se preocupe
 * mais com o conteudo da resposta do que com o transporte.
 *
 * @param {unknown} data Conteudo serializavel que sera devolvido ao cliente.
 * @param {ResponseInit} [init={}] Parametros opcionais como `status` e headers.
 * @returns {Response} Resposta HTTP JSON pronta para ser retornada.
 */
export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

/**
 * Gera uma resposta de erro padronizada.
 * Essa funcao reduz variacao entre handlers e ajuda a manter um contrato
 * minimo previsivel para chamadas internas e futuras integracoes.
 *
 * @param {string} code Codigo de erro estavel para o consumidor.
 * @param {number} status Status HTTP da resposta.
 * @param {Record<string, unknown>} [details={}] Detalhes adicionais do erro.
 * @returns {Response} Resposta JSON de erro.
 */
export function errorResponse(code, status, details = {}) {
  return jsonResponse(
    {
      ok: false,
      error: code,
      ...details,
    },
    { status },
  );
}
