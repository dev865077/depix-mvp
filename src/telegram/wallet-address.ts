// @ts-nocheck
import { bech32, bech32m } from "bech32";
import * as blech32 from "blech32/dist/blech32.cjs.development.js";

const SUPPORTED_DEPIX_ADDRESS_PREFIXES = Object.freeze(["lq1", "ex1"]);
const SUPPORTED_UNCONFIDENTIAL_LIQUID_PARSERS = Object.freeze([bech32, bech32m]);
const SUPPORTED_CONFIDENTIAL_LIQUID_ENCODINGS = Object.freeze([
  blech32.BLECH32,
  blech32.BLECH32M,
]);

/**
 * Executa funcoes de parse em sequencia ate uma delas aceitar o endereco.
 *
 * Isso permite delegar checksum e estrutura para bibliotecas consolidadas sem
 * duplicar a logica no projeto. Quando nenhuma variante passa, retornamos
 * `null` para o chamador traduzir em `invalid_format`.
 *
 * @template T
 * @param {Array<(normalizedAddress: string) => T>} parsers Parsers candidatos.
 * @param {string} normalizedAddress Endereco ja normalizado.
 * @returns {T | null} Resultado do primeiro parser valido.
 */
function parseWithFirstSupportedParser(parsers, normalizedAddress) {
  for (const parser of parsers) {
    try {
      return parser(normalizedAddress);
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Valida um endereco confidencial Liquid com a implementacao `blech32`.
 *
 * Tentamos `BLECH32` e `BLECH32M` para cobrir witness versions atuais e
 * futuras sem criar um parser caseiro. O contrato final ainda exige HRP `lq`.
 *
 * @param {string} normalizedAddress Endereco ja sem whitespace e em lowercase.
 * @returns {boolean} Verdadeiro quando o endereco e um `lq1` valido.
 */
function isValidConfidentialLiquidAddress(normalizedAddress) {
  const decodedAddress = parseWithFirstSupportedParser(
    SUPPORTED_CONFIDENTIAL_LIQUID_ENCODINGS.map(function buildBlech32Parser(encoding) {
      return function parseConfidentialAddress(addressToParse) {
        return blech32.decode(addressToParse, encoding);
      };
    }),
    normalizedAddress,
  );

  return decodedAddress?.hrp === "lq";
}

/**
 * Valida um endereco Liquid nao confidencial com os parsers `bech32`.
 *
 * Mesmo com prefixo `ex1`, ainda confirmamos o prefixo decodificado para
 * impedir aceitar redes externas que por acaso passassem por uma heuristica
 * superficial de texto.
 *
 * @param {string} normalizedAddress Endereco ja sem whitespace e em lowercase.
 * @returns {boolean} Verdadeiro quando o endereco e um `ex1` valido.
 */
function isValidUnconfidentialLiquidAddress(normalizedAddress) {
  const decodedAddress = parseWithFirstSupportedParser(
    SUPPORTED_UNCONFIDENTIAL_LIQUID_PARSERS.map(function buildBech32Parser(parser) {
      return function parseUnconfidentialAddress(addressToParse) {
        return parser.decode(addressToParse);
      };
    }),
    normalizedAddress,
  );

  return decodedAddress?.prefix === "ex";
}

/**
 * Resolve o validador canonico a partir do prefixo observado no texto.
 *
 * @param {string} normalizedAddress Endereco normalizado.
 * @returns {boolean} Verdadeiro quando o endereco passa pelo parser canonico.
 */
function isSupportedDepixLiquidAddress(normalizedAddress) {
  const supportedPrefix = SUPPORTED_DEPIX_ADDRESS_PREFIXES.find(function matchSupportedPrefix(prefix) {
    return normalizedAddress.startsWith(prefix);
  });

  if (!supportedPrefix) {
    return false;
  }

  if (supportedPrefix === "lq1") {
    return isValidConfidentialLiquidAddress(normalizedAddress);
  }

  return isValidUnconfidentialLiquidAddress(normalizedAddress);
}

/**
 * Normaliza e valida o endereco DePix/Liquid informado no Telegram.
 *
 * SideSwap pode exibir o endereco em grupos visuais separados por espacos ou
 * quebras de linha. O runtime remove esse whitespace visual antes do parse e
 * delega a validacao estrutural para `bech32` e `blech32`, evitando parser
 * local de checksum e aceitando apenas os prefixos operacionais do projeto.
 *
 * @param {string} rawText Texto bruto enviado pelo usuario.
 * @returns {(
 *   | {
 *       ok: true,
 *       walletAddress: string
 *     }
 *   | {
 *       ok: false,
 *       reason: "empty" | "uri_not_supported" | "invalid_format"
 *     }
 * )} Resultado normalizado ou motivo de rejeicao.
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

  if (!isSupportedDepixLiquidAddress(normalizedAddress)) {
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

export { SUPPORTED_DEPIX_ADDRESS_PREFIXES };
