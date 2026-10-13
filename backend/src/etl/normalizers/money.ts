/**
 * Monetary amount parsing for `account_balance`.
 *
 * Handles currency symbols and ISO codes ($, €, £, USD...), thousands
 * separators ("2,450.75", "1 250.00"), and negatives written as "-15.00",
 * "$-15.00", "-$15.00" or "(15.00)". Separators are only accepted in correct
 * 3-digit groups: "300,00" and "300 00" are rejected rather than silently read
 * as 30000. Conflicting markers ("(-15.00)", "€100 USD") are rejected too.
 */

export type MoneyParseResult =
  | {
      ok: true;
      value: number;
      /** ISO 4217 code when a symbol/code was present, otherwise null (assumed base currency). */
      currency: string | null;
      /** True when symbols, codes, grouping or accounting parentheses had to be stripped. */
      cleaned: boolean;
    }
  | { ok: false; reason: string };

const CURRENCY_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ['US$', 'USD'],
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
];
const CURRENCY_CODE = /\b(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF)\b/i;
const AMOUNT = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$|^\.\d+$/;
const SPACE_GROUPED = /^\d{1,3}(?: \d{3})+(?:\.\d+)?$/;
const DECIMAL_COMMA = /^\d+,\d{1,2}$/;

export const BASE_CURRENCY = 'USD';

export function parseMoney(raw: string): MoneyParseResult {
  const original = raw.trim();
  // Exports often group thousands with (narrow) no-break spaces.
  let text = original.replace(/[  ]/g, ' ');
  if (!text) return { ok: false, reason: 'empty value' };

  let negativeMarkers = 0;
  let cleaned = false;
  const currencies = new Set<string>();

  if (text.startsWith('(') && text.endsWith(')')) {
    negativeMarkers += 1;
    cleaned = true;
    text = text.slice(1, -1).trim();
  }

  const code = CURRENCY_CODE.exec(text);
  if (code?.[1]) {
    currencies.add(code[1].toUpperCase());
    text = text.replace(CURRENCY_CODE, '');
    cleaned = true;
  }
  for (const [symbol, iso] of CURRENCY_SYMBOLS) {
    if (text.includes(symbol)) {
      currencies.add(iso);
      text = text.split(symbol).join('');
      cleaned = true;
    }
  }
  if (currencies.size > 1) {
    return { ok: false, reason: `"${original}" carries conflicting currency markers (${[...currencies].join(', ')})` };
  }
  text = text.trim();

  const leadingSign = /^([+-])\s*/.exec(text);
  if (leadingSign) {
    if (leadingSign[1] === '-') negativeMarkers += 1;
    text = text.slice(leadingSign[0].length);
  }
  const trailingMinus = /\s*-$/.exec(text);
  if (trailingMinus) {
    negativeMarkers += 1;
    text = text.slice(0, trailingMinus.index);
  }
  if (negativeMarkers > 1) return { ok: false, reason: `"${original}" has more than one negative marker` };

  if (/\s/.test(text)) {
    if (!SPACE_GROUPED.test(text)) {
      return { ok: false, reason: `"${original}" contains spaces that are not thousands separators` };
    }
    text = text.replace(/ /g, '');
    cleaned = true;
  }

  if (!AMOUNT.test(text)) {
    return {
      ok: false,
      reason: DECIMAL_COMMA.test(text)
        ? `"${original}" looks like a decimal comma; refusing to guess the amount`
        : `"${original}" is not a recognisable amount`,
    };
  }
  if (text.includes(',')) cleaned = true;

  const magnitude = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(magnitude)) return { ok: false, reason: `"${original}" is out of range` };
  // Avoid -0 when the source says "-0.00".
  const value = negativeMarkers === 1 && magnitude !== 0 ? -magnitude : magnitude;
  return { ok: true, value, currency: [...currencies][0] ?? null, cleaned };
}
