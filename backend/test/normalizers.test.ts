import { describe, expect, it } from 'vitest';
import { EMAIL_PATTERN, isPlausibleEmail } from '../src/domain/patient.js';
import { normalizeDob, parseDate } from '../src/etl/normalizers/date.js';
import { parseMoney } from '../src/etl/normalizers/money.js';
import { normalizePatientId } from '../src/etl/normalizers/text.js';
import { parseTimestamp } from '../src/etl/normalizers/timestamp.js';

describe('parseDate', () => {
  it.each([
    ['1980-05-15', '1980-05-15', 'YYYY-MM-DD'],
    ['12/31/1992', '1992-12-31', 'MM/DD/YYYY'],
    ['25-04-1975', '1975-04-25', 'DD-MM-YYYY'],
    ['04/25/1975', '1975-04-25', 'MM/DD/YYYY'],
    ['15-08-1999', '1999-08-15', 'DD-MM-YYYY'],
    ['15.08.1999', '1999-08-15', 'DD.MM.YYYY'],
    ['1980/5/7', '1980-05-07', 'YYYY/MM/DD'],
    ['1980-05-15T00:00:00Z', '1980-05-15', 'YYYY-MM-DD'],
    ['15 Aug 1999', '1999-08-15', 'D MMM YYYY'],
    ['August 15, 1999', '1999-08-15', 'MMM D, YYYY'],
  ])('reads %s as %s (%s)', (raw, iso, format) => {
    expect(parseDate(raw)).toMatchObject({ ok: true, iso, format });
  });

  it('flags day/month ambiguity and applies the separator convention', () => {
    expect(parseDate('07/04/1988')).toMatchObject({ ok: true, iso: '1988-07-04', ambiguous: true, inferred: false });
    expect(parseDate('07-04-1988')).toMatchObject({ ok: true, iso: '1988-04-07', ambiguous: true });
    expect(parseDate('04/04/1988')).toMatchObject({ ok: true, ambiguous: false });
  });

  it('infers swapped order when the convention is impossible', () => {
    expect(parseDate('25/04/1975')).toMatchObject({ ok: true, iso: '1975-04-25', format: 'DD/MM/YYYY', inferred: true });
    expect(parseDate('04-25-1975')).toMatchObject({ ok: true, iso: '1975-04-25', format: 'MM-DD-YYYY', inferred: true });
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(parseDate('02/30/1990').ok).toBe(false);
    expect(parseDate('1990-02-30').ok).toBe(false);
    expect(parseDate('13/13/2000').ok).toBe(false);
    expect(parseDate('1990-13-01').ok).toBe(false);
  });

  it('applies leap-year rules', () => {
    expect(parseDate('02/29/2000').ok).toBe(true);
    expect(parseDate('2024-02-29').ok).toBe(true);
    expect(parseDate('02/29/1900').ok).toBe(false);
    expect(parseDate('2023-02-29').ok).toBe(false);
  });

  it('refuses two-digit years and unknown formats', () => {
    expect(parseDate('07/04/88')).toMatchObject({ ok: false, reason: expect.stringContaining('two-digit year') });
    expect(parseDate('N/A').ok).toBe(false);
    expect(parseDate('').ok).toBe(false);
  });

  it('accepts a time after a year-first date, but no other trailing text', () => {
    expect(parseDate('1980-05-15 00:00:00')).toMatchObject({ ok: true, iso: '1980-05-15' });
    expect(parseDate('1980-05-15T00:00:00+05:30')).toMatchObject({ ok: true, iso: '1980-05-15' });
    expect(parseDate('1980-05-15 garbage').ok).toBe(false);
  });

  it('only accepts real month names and abbreviations', () => {
    expect(parseDate('Sept 5, 1990')).toMatchObject({ ok: true, iso: '1990-09-05' });
    expect(parseDate('5 September 1990')).toMatchObject({ ok: true, iso: '1990-09-05' });
    expect(parseDate('Decimal 5, 1990')).toMatchObject({ ok: false, reason: expect.stringContaining('month name') });
  });
});

describe('normalizeDob', () => {
  const today = new Date('2026-10-10T12:00:00Z');

  it('rejects dates of birth in the future', () => {
    expect(normalizeDob('2030-01-01', today)).toMatchObject({ ok: false, reason: expect.stringContaining('future') });
    expect(normalizeDob('2026-10-10', today).ok).toBe(true);
  });

  it('flags dates before 1900 without rejecting them', () => {
    expect(normalizeDob('1899-12-31', today)).toMatchObject({ ok: true, beforeMinYear: true });
  });
});

describe('parseMoney', () => {
  it.each([
    ['$150.50', 150.5, 'USD'],
    ['1,250.00', 1250, null],
    ['€300.00', 300, 'EUR'],
    ['0.00', 0, null],
    ['2,450.75', 2450.75, null],
    ['$0.00', 0, 'USD'],
    ['$45.50', 45.5, 'USD'],
    ['$-15.00', -15, 'USD'],
    ['-$15.00', -15, 'USD'],
    ['($1,234.50)', -1234.5, 'USD'],
    ['USD 1,000', 1000, 'USD'],
    ['£ 12.30', 12.3, 'GBP'],
    ['1234567.891', 1234567.891, null],
  ])('parses %s as %d (%s)', (raw, value, currency) => {
    expect(parseMoney(raw)).toMatchObject({ ok: true, value, currency });
  });

  it('never produces -0', () => {
    const result = parseMoney('-0.00');
    expect(result.ok && Object.is(result.value, 0)).toBe(true);
  });

  it('rejects decimal commas and mis-grouped numbers rather than guessing', () => {
    expect(parseMoney('300,00')).toMatchObject({ ok: false, reason: expect.stringContaining('decimal comma') });
    expect(parseMoney('1,2345.00').ok).toBe(false);
    expect(parseMoney('12.5.3').ok).toBe(false);
    expect(parseMoney('abc').ok).toBe(false);
    expect(parseMoney('').ok).toBe(false);
  });

  it('accepts spaces only as correctly grouped thousands separators', () => {
    expect(parseMoney('1 250.00')).toMatchObject({ ok: true, value: 1250, cleaned: true });
    expect(parseMoney('1 250.00')).toMatchObject({ ok: true, value: 1250 });
    expect(parseMoney('$ 150.50')).toMatchObject({ ok: true, value: 150.5 });
    expect(parseMoney('300 00')).toMatchObject({ ok: false, reason: expect.stringContaining('spaces') });
    expect(parseMoney('45 50').ok).toBe(false);
  });

  it('rejects conflicting negative or currency markers instead of resolving them silently', () => {
    expect(parseMoney('-15.00-')).toMatchObject({ ok: false, reason: expect.stringContaining('negative') });
    expect(parseMoney('(-15.00)').ok).toBe(false);
    expect(parseMoney('15.00-')).toMatchObject({ ok: true, value: -15 });
    expect(parseMoney('€100 USD')).toMatchObject({ ok: false, reason: expect.stringContaining('conflicting currency') });
    expect(parseMoney('$100 USD')).toMatchObject({ ok: true, value: 100, currency: 'USD' });
  });
});

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses and rejects export corruption', () => {
    for (const ok of ['john.doe@email.com', 'a@b.co', 'alice.j+tag@mail.example.org']) expect(isPlausibleEmail(ok)).toBe(true);
    for (const bad of ['john.doe@', 'john.doe.email.com', 'jane smith@x.com', 'x@@y.com', 'a@b..com', 'a@.com', 'a@b']) {
      expect(isPlausibleEmail(bad)).toBe(false);
    }
  });

  it('stays fast on hostile input (no catastrophic backtracking)', () => {
    const hostile = `a@${'b.'.repeat(100_000)}@`;
    const started = performance.now();
    expect(EMAIL_PATTERN.test(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(isPlausibleEmail(`${'a'.repeat(250)}@b.com`)).toBe(false);
  });
});

describe('parseTimestamp', () => {
  it('normalises ISO 8601 timestamps to UTC', () => {
    expect(parseTimestamp('2026-10-05T14:20:00Z')).toMatchObject({ ok: true, iso: '2026-10-05T14:20:00.000Z', assumedUtc: false });
    expect(parseTimestamp('2026-10-05T16:20:00+02:00')).toMatchObject({ ok: true, iso: '2026-10-05T14:20:00.000Z' });
    expect(parseTimestamp('2026-10-05T16:20:00+0200')).toMatchObject({ ok: true, iso: '2026-10-05T14:20:00.000Z' });
  });

  it('treats zone-less timestamps as UTC and says so', () => {
    expect(parseTimestamp('2026-10-05 14:20:00')).toMatchObject({ ok: true, iso: '2026-10-05T14:20:00.000Z', assumedUtc: true });
  });

  it('accepts hour-only offsets and a UTC suffix, as database text exports write them', () => {
    expect(parseTimestamp('2026-10-05 14:20:00+00')).toMatchObject({ ok: true, iso: '2026-10-05T14:20:00.000Z', assumedUtc: false });
    expect(parseTimestamp('2026-10-05 19:50:00+05:30')).toMatchObject({ ok: true, iso: '2026-10-05T14:20:00.000Z' });
    expect(parseTimestamp('2026-10-05 14:20:00 UTC')).toMatchObject({ ok: true, iso: '2026-10-05T14:20:00.000Z', assumedUtc: false });
  });

  it('rejects impossible or non-ISO values', () => {
    expect(parseTimestamp('2026-02-30T00:00:00Z').ok).toBe(false);
    expect(parseTimestamp('2026-10-05T25:00:00Z').ok).toBe(false);
    expect(parseTimestamp('yesterday').ok).toBe(false);
  });
});

describe('normalizePatientId', () => {
  it('trims and upper-cases so duplicates match', () => {
    expect(normalizePatientId('  p-1001 ')).toBe('P-1001');
  });
});
