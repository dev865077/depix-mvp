/**
 * Este arquivo conecta o contrato publico do Cloudflare Worker a aplicacao do
 * projeto. Ele existe para manter a entrada do runtime pequena, estavel e
 * facil de localizar, enquanto a logica real fica distribuida em modulos mais
 * claros. A visao da fundacao atual esta em `docs/ARCHITECTURE-FOUNDATION.md`.
 */

import { createApp } from "./app.js";

/**
 * Exporta a aplicacao do Worker no formato esperado pela Cloudflare.
 * Mantemos essa etapa como um simples encaminhamento para que futuras
 * implementacoes nao precisem disputar espaco com o bootstrap do runtime.
 */
export default createApp();
