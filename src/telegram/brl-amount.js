const MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS = 1_000_000;
const SIMPLE_BRL_AMOUNT_PATTERN = /^(?:R\$\s*)?(\d+)(?:,(\d{2}))?$/u;

/**
 * Interpreta valores BRL digitados no chat do Telegram.
 *
 * O parser e intencionalmente conservador: nesta primeira etapa do fluxo ele
 * aceita apenas valores isolados e sem separador de milhar. Isso evita aceitar
 * mensagens ambiguas como `10.50`, `10 reais` ou `10,5` como dinheiro real.
 * Quando o fluxo amadurecer, novos formatos podem ser adicionados com testes
 * explicitos sem enfraquecer este contrato inicial.
 *
 * @param {string} rawText Texto bruto enviado pelo usuario.
 * @returns {{
 *   ok: true,
 *   amountInCents: number
 * } | {
 *   ok: false,
 *   reason: "empty" | "invalid_format" | "non_positive" | "above_limit",
 *   maxAmountInCents: number
 * }} Resultado parseado ou motivo de rejeicao.
 */
export function parseTelegramBrlAmount(rawText) {
  const text = typeof rawText === "string" ? rawText.trim() : "";

  if (text.length === 0) {
    return {
      ok: false,
      reason: "empty",
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    };
  }

  const match = SIMPLE_BRL_AMOUNT_PATTERN.exec(text);

  if (!match) {
    return {
      ok: false,
      reason: "invalid_format",
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    };
  }

  const reais = Number.parseInt(match[1], 10);
  const cents = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  const amountInCents = (reais * 100) + cents;

  if (!Number.isSafeInteger(amountInCents) || amountInCents <= 0) {
    return {
      ok: false,
      reason: "non_positive",
      maxAmountInCents: MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS,
    };
  }

  if (amountInCents > MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS) {
    return {
      ok: false,
      reason: "above_limit",
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
 * @returns {string} Valor em BRL, como `R$ 10,50`.
 */
export function formatBrlAmountInCents(amountInCents) {
  if (!Number.isSafeInteger(amountInCents) || amountInCents < 0) {
    return "R$ 0,00";
  }

  const reais = Math.trunc(amountInCents / 100);
  const reaisText = String(reais).replace(/\B(?=(\d{3})+(?!\d))/gu, ".");
  const cents = String(amountInCents % 100).padStart(2, "0");

  return `R$ ${reaisText},${cents}`;
}

export { MAX_TELEGRAM_ORDER_AMOUNT_IN_CENTS };
