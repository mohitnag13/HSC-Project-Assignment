/**
 * Date-of-birth parsing.
 *
 * The legacy export mixes three layouts. The separator, not the digits,
 * decides how a value is read, because that is the only signal that stays
 * reliable when day and month are both <= 12:
 *
 *   YYYY-MM-DD  year first            -> unambiguous ISO 8601
 *   MM/DD/YYYY  slash, year last      -> US convention (month first)
 *   DD-MM-YYYY  dash/dot, year last   -> day-first convention
 *
 * If a value is impossible under its convention but valid with day and month
 * swapped (e.g. "25/04/1975"), it is accepted and flagged as inferred. Values
 * that are not real calendar dates are rejected, never rolled over the way
 * `new Date("1990-02-30")` silently does.
 */

export type DateParseResult =
  | { ok: true; iso: string; format: string; ambiguous: boolean; inferred: boolean }
  | { ok: false; reason: string };

// A year-first value may carry a time (exports of DATETIME columns), but nothing else.
const YEAR_FIRST = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|UTC|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const YEAR_LAST = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/;
const TWO_DIGIT_YEAR = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$/;
const DAY_MONTHNAME_YEAR = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/;
const MONTHNAME_DAY_YEAR = /^([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4})$/;

const MONTHS = new Map<string, number>();
[
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
].forEach((name, index) => {
  MONTHS.set(name, index + 1);
  MONTHS.set(name.slice(0, 3), index + 1);
});
MONTHS.set('sept', 9);

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export function toIsoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Full month names and their usual abbreviations only ("Decimal" is not December). */
function monthFromName(name: string): number | null {
  return MONTHS.get(name.toLowerCase()) ?? null;
}

function accept(year: number, month: number, day: number, format: string, ambiguous = false, inferred = false): DateParseResult {
  return { ok: true, iso: toIsoDate(year, month, day), format, ambiguous, inferred };
}

export function parseDate(raw: string): DateParseResult {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty value' };

  const yearFirst = YEAR_FIRST.exec(value);
  if (yearFirst) {
    const [, y = '', separator = '-', m = '', d = ''] = yearFirst;
    const [year, month, day] = [Number(y), Number(m), Number(d)];
    if (!isValidCalendarDate(year, month, day)) return { ok: false, reason: `"${value}" is not a real calendar date` };
    return accept(year, month, day, `YYYY${separator}MM${separator}DD`);
  }

  const yearLast = YEAR_LAST.exec(value);
  if (yearLast) {
    const [, a = '', separator = '/', b = '', y = ''] = yearLast;
    const [first, second, year] = [Number(a), Number(b), Number(y)];
    const monthFirst = separator === '/';
    const monthFirstFormat = `MM${separator}DD${separator}YYYY`;
    const dayFirstFormat = `DD${separator}MM${separator}YYYY`;
    const primary = monthFirst
      ? { month: first, day: second, format: monthFirstFormat }
      : { month: second, day: first, format: dayFirstFormat };
    const swapped = monthFirst
      ? { month: second, day: first, format: dayFirstFormat }
      : { month: first, day: second, format: monthFirstFormat };

    if (isValidCalendarDate(year, primary.month, primary.day)) {
      const ambiguous = first !== second && first <= 12 && second <= 12;
      return accept(year, primary.month, primary.day, primary.format, ambiguous);
    }
    if (isValidCalendarDate(year, swapped.month, swapped.day)) {
      return accept(year, swapped.month, swapped.day, swapped.format, false, true);
    }
    return { ok: false, reason: `"${value}" is not a real calendar date` };
  }

  const dayMonthName = DAY_MONTHNAME_YEAR.exec(value);
  if (dayMonthName) {
    const [, d = '', name = '', y = ''] = dayMonthName;
    const month = monthFromName(name);
    if (month === null) return { ok: false, reason: `"${value}" has an unrecognised month name` };
    if (isValidCalendarDate(Number(y), month, Number(d))) return accept(Number(y), month, Number(d), 'D MMM YYYY');
    return { ok: false, reason: `"${value}" is not a real calendar date` };
  }

  const monthNameDay = MONTHNAME_DAY_YEAR.exec(value);
  if (monthNameDay) {
    const [, name = '', d = '', y = ''] = monthNameDay;
    const month = monthFromName(name);
    if (month === null) return { ok: false, reason: `"${value}" has an unrecognised month name` };
    if (isValidCalendarDate(Number(y), month, Number(d))) return accept(Number(y), month, Number(d), 'MMM D, YYYY');
    return { ok: false, reason: `"${value}" is not a real calendar date` };
  }

  if (TWO_DIGIT_YEAR.test(value)) {
    return { ok: false, reason: `"${value}" uses a two-digit year; the century cannot be determined safely` };
  }
  return { ok: false, reason: `"${value}" is not in a recognised date format` };
}

export const MIN_PLAUSIBLE_BIRTH_YEAR = 1900;

export type DobResult =
  | (Extract<DateParseResult, { ok: true }> & { beforeMinYear: boolean })
  | { ok: false; reason: string };

/** Applies date-of-birth rules on top of {@link parseDate}: no future dates; pre-1900 is flagged. */
export function normalizeDob(raw: string, today: Date = new Date()): DobResult {
  const parsed = parseDate(raw);
  if (!parsed.ok) return parsed;
  const todayIso = today.toISOString().slice(0, 10);
  if (parsed.iso > todayIso) return { ok: false, reason: `date of birth ${parsed.iso} is in the future` };
  return { ...parsed, beforeMinYear: Number(parsed.iso.slice(0, 4)) < MIN_PLAUSIBLE_BIRTH_YEAR };
}
