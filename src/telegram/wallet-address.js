const SUPPORTED_DEPIX_ADDRESS_PREFIXES = Object.freeze(["lq1", "ex1"]);
const SUPPORTED_DEPIX_ADDRESS_LENGTHS_BY_PREFIX = Object.freeze({
  lq1: new Set([101]),
  ex1: new Set([42, 43]),
});
const BECH32_DATA_CHARSET_PATTERN = /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/u;

/**
 * Normaliza e valida o endereco DePix/Liquid informado no Telegram.
 *
 * SideSwap pode exibir o endereco em grupos visuais separados por espacos ou
 * quebras de linha. Para o MVP, removemos whitespace visual e aceitamos apenas
 * prefixos, comprimentos e alfabeto bech32 ja observados/documentados
 * (`lq1` e `ex1`). Essa fronteira evita falso positivo como `lq1... texto`,
 * que poderia continuar alfanumerico depois de remover espacos.
 *
 * @param {string} rawText Texto bruto enviado pelo usuario.
 * @returns {{
 *   ok: true,
 *   walletAddress: string
 * } | {
 *   ok: false,
 *   reason: "empty" | "uri_not_supported" | "invalid_format"
 * }} Resultado normalizado ou motivo de rejeicao.
 */
export function parseTelegramWalletAddress(rawText) {
  const text = typeof rawText === "string" ? rawText.trim() : "";

  if (text.length === 0) {
    return {
      ok: false,
      reason: "empty",
    };
  }

  if (text.includes(":")) {
    return {
      ok: false,
      reason: "uri_not_supported",
    };
  }

  const normalizedAddress = text.replace(/\s+/gu, "").toLowerCase();
  const supportedPrefix = SUPPORTED_DEPIX_ADDRESS_PREFIXES.find((prefix) => normalizedAddress.startsWith(prefix));

  if (
    !supportedPrefix
    || !SUPPORTED_DEPIX_ADDRESS_LENGTHS_BY_PREFIX[supportedPrefix].has(normalizedAddress.length)
    || !BECH32_DATA_CHARSET_PATTERN.test(normalizedAddress.slice(supportedPrefix.length))
  ) {
    return {
      ok: false,
      reason: "invalid_format",
    };
  }

  return {
    ok: true,
    walletAddress: normalizedAddress,
  };
}

export {
  SUPPORTED_DEPIX_ADDRESS_LENGTHS_BY_PREFIX,
  SUPPORTED_DEPIX_ADDRESS_PREFIXES,
};
