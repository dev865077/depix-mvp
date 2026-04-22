const MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS = 300;
const MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS = 1_000_000;
const WHOLE_BRL_AMOUNT_PATTERN = /^(?:R\$\s*)?(\d+)$/u;
const CENTS_BRL_AMOUNT_PATTERN = /^(?:R\$\s*)?\d+,\d+$/u;

/**
 * Interpreta valores BRL digitados no chat do Telegram.
 *
 * O parser e intencionalmente conservador: nesta primeira etapa do fluxo ele
 * aceita apenas reais inteiros e sem separador de milhar. Isso evita aceitar
 * mensagens ambiguas como `10.50`, `10 reais` ou qualquer valor com centavos.
 * Quando o fluxo amadurecer, novos formatos podem ser adicionados com testes
 * explicitos sem enfraquecer este contrato inicial.
 *
 * @param {string} rawText Texto bruto enviado pelo usuario.
 * @returns {{
 *   ok: true,
 *   amountInCents: number
 * } | {
 *   ok: false,
 *   reason: "empty" | "invalid_format" | "cents_not_supported" | "below_minimum" | "above_limit",
 *   minAmountInCents: number,
 *   maxAmountInCents: number
 * }} Resultado parseado ou motivo de rejeicao.
 */
export function parseTelegramBrlAmount(rawText: string) {
  const text = typeof rawText === "string" ? rawText.trim() : "";

  if (text.length === 0) {
    return {
      ok: false,
      reason: "empty",
      minAmountInCents: MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    };
  }

  if (CENTS_BRL_AMOUNT_PATTERN.test(text)) {
    return {
      ok: false,
      reason: "cents_not_supported",
      minAmountInCents: MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    };
  }

  const match = WHOLE_BRL_AMOUNT_PATTERN.exec(text);

  if (!match) {
    return {
      ok: false,
      reason: "invalid_format",
      minAmountInCents: MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    };
  }

  const reais = Number.parseInt(match[1], 10);
  const amountInCents = reais * 100;

  if (!Number.isSafeInteger(amountInCents) || amountInCents < MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS) {
    return {
      ok: false,
      reason: "below_minimum",
      minAmountInCents: MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    };
  }

  if (amountInCents > MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS) {
    return {
      ok: false,
      reason: "above_limit",
      minAmountInCents: MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    };
  }

  return {
    ok: true,
    amountInCents,
  };
}

/**
 * Formata centavos BRL sem depender de locale do runtime.
 *
 * Workers, Node e ambientes de teste podem renderizar `Intl.NumberFormat` com
 * espacos especiais diferentes. Para mensagens e assercoes deterministicas, a
 * formatacao manual e suficiente e segue o padrao brasileiro esperado.
 *
 * @param {number} amountInCents Valor inteiro em centavos.
 * @returns {string} Valor em BRL, como `R$ 10`.
 */
export function formatBrlAmountInCents(amountInCents: number) {
  if (!Number.isSafeInteger(amountInCents) || amountInCents < 0) {
    return "R$ 0";
  }

  const reais = Math.trunc(amountInCents / 100);
  const reaisText = String(reais).replace(/\B(?=(\d{3})+(?!\d))/gu, ".");

  return `R$ ${reaisText}`;
}

export { MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS, MIN_TELEGRAM_ORDER_AMOUNT_IN_CENTS };
