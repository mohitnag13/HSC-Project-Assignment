import { isValidCalendarDate } from './date.js';

export type TimestampParseResult =
  | { ok: true; iso: string; epochMs: number; assumedUtc: boolean }
  | { ok: false; reason: string };

// Zone: Z, UTC, +HH, +HHMM or +HH:MM (database text exports often use "+00" or " UTC").
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?)?\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Parses `last_modified` (ISO 8601). Values without a zone designator are
 * interpreted as UTC and flagged, instead of letting `Date` silently apply the
 * host's local time zone.
 */
export function parseTimestamp(raw: string): TimestampParseResult {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty value' };

  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return { ok: false, reason: `"${value}" is not an ISO 8601 timestamp` };

  const [, y = '', mo = '', d = '', hh = '00', mm = '00', ss = '00', fraction = '', zone] = match;
  if (!isValidCalendarDate(Number(y), Number(mo), Number(d)) || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) {
    return { ok: false, reason: `"${value}" is not a real point in time` };
  }

  const millis = fraction ? fraction.slice(1, 4).padEnd(3, '0') : '000';
  let offset = 'Z';
  if (zone && !/^(?:z|utc)$/i.test(zone)) {
    const digits = zone.replace(':', '');
    offset = digits.length === 3 ? `${digits}:00` : `${digits.slice(0, 3)}:${digits.slice(3)}`;
  }
  const epochMs = Date.parse(`${y}-${mo}-${d}T${hh}:${mm}:${ss}.${millis}${offset}`);
  if (Number.isNaN(epochMs)) return { ok: false, reason: `"${value}" is not a real point in time` };

  return { ok: true, iso: new Date(epochMs).toISOString(), epochMs, assumedUtc: zone === undefined };
}
