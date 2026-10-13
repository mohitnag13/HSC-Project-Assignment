import { PATIENT_COLUMNS, isPlausiblePhone, type PatientColumn } from '../domain/patient.js';
import type { CsvDocument } from './csvReader.js';
import { parseDate } from './normalizers/date.js';
import { parseMoney } from './normalizers/money.js';
import { parseTimestamp } from './normalizers/timestamp.js';

export type RowValues = Record<PatientColumn, string>;

export interface RowRepair {
  kind: 'merged' | 'inserted';
  columns: PatientColumn[];
  fieldCount: number;
  detail: string;
}

export type AlignResult =
  | { ok: true; values: RowValues; repair: RowRepair | null }
  | { ok: false; reason: string };

/**
 * Columns whose values can legitimately contain the delimiter when the
 * exporter forgets to quote them ("1,250.00", "Smith, Jr.").
 */
const MERGEABLE: readonly PatientColumn[] = ['first_name', 'last_name', 'account_balance'];

/** Optional columns an exporter may drop entirely instead of leaving empty. */
const INSERTABLE: readonly PatientColumn[] = ['email', 'phone'];

type Layout = Pick<CsvDocument, 'header' | 'columnIndex'>;

function toValues(fields: readonly string[], layout: Layout): RowValues {
  const values = {} as RowValues;
  for (const column of PATIENT_COLUMNS) values[column] = fields[layout.columnIndex[column]] ?? '';
  return values;
}

/**
 * Structural plausibility used only to choose between candidate alignments:
 * every required, typed field must parse. A misaligned row almost never
 * passes because dates, amounts and timestamps land in the wrong columns.
 */
export function isStructurallyPlausible(values: RowValues): boolean {
  return (
    values.patient_id.trim() !== '' &&
    values.first_name.trim() !== '' &&
    values.last_name.trim() !== '' &&
    parseDate(values.dob).ok &&
    parseMoney(values.account_balance).ok &&
    parseTimestamp(values.last_modified).ok
  );
}

/**
 * How many optional contact fields look like what they claim to be. Used only
 * to break ties: a bad phone number in an otherwise clear row is a warning,
 * not a reason to quarantine it.
 */
function contactScore(values: RowValues): number {
  const email = values.email.trim();
  const phone = values.phone.trim();
  return (email === '' || email.includes('@') ? 1 : 0) + (phone === '' || isPlausiblePhone(phone) ? 1 : 0);
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, index) =>
    combinations(items.slice(index + 1), size - 1).map((rest) => [item, ...rest]),
  );
}

/**
 * Aligns a tokenised row with the header. Rows with extra fields are merged
 * back into a comma-tolerant column; rows with missing fields get empty
 * optional columns inserted. A repair is accepted only when exactly one
 * distinct reading is structurally plausible (contact fields break ties);
 * anything else is quarantined.
 */
export function alignRow(rawFields: readonly string[], layout: Layout): AlignResult {
  const width = layout.header.length;
  // A trailing delimiter adds empty fields that carry no data.
  const fields =
    rawFields.length > width && rawFields.slice(width).every((field) => field.trim() === '') ? rawFields.slice(0, width) : rawFields;
  if (fields.length === width) return { ok: true, values: toValues(fields, layout), repair: null };

  const candidates: Array<{ values: RowValues; repair: RowRepair }> = [];

  if (fields.length > width) {
    const extra = fields.length - width;
    for (const column of MERGEABLE) {
      const at = layout.columnIndex[column];
      const merged = fields.slice(at, at + extra + 1).join(',');
      const realigned = [...fields.slice(0, at), merged, ...fields.slice(at + extra + 1)];
      const values = toValues(realigned, layout);
      if (isStructurallyPlausible(values)) {
        candidates.push({
          values,
          repair: {
            kind: 'merged',
            columns: [column],
            fieldCount: fields.length,
            detail: `${fields.length} fields for ${width} columns; re-joined ${fields
              .slice(at, at + extra + 1)
              .map((field) => `"${field}"`)
              .join(' + ')} into ${column} = "${merged}"`,
          },
        });
      }
    }
  } else {
    const missing = width - fields.length;
    for (const columns of combinations(INSERTABLE, missing)) {
      const positions = columns.map((column) => layout.columnIndex[column]).sort((a, b) => a - b);
      const realigned = [...fields];
      for (const position of positions) realigned.splice(position, 0, '');
      const values = toValues(realigned, layout);
      if (isStructurallyPlausible(values)) {
        candidates.push({
          values,
          repair: {
            kind: 'inserted',
            columns,
            fieldCount: fields.length,
            detail: `${fields.length} fields for ${width} columns; treated ${columns.join(' and ')} as absent`,
          },
        });
      }
    }
  }

  // Readings that produce identical values are the same reading.
  const distinct = [...new Map(candidates.map((candidate) => [JSON.stringify(candidate.values), candidate])).values()];
  const bestScore = Math.max(0, ...distinct.map((candidate) => contactScore(candidate.values)));
  const best = distinct.filter((candidate) => contactScore(candidate.values) === bestScore);

  const [only, ...others] = best;
  if (only && others.length === 0) return { ok: true, values: only.values, repair: only.repair };
  return {
    ok: false,
    reason:
      best.length === 0
        ? `${fields.length} fields for ${width} columns and no realignment produces a valid record`
        : `${fields.length} fields for ${width} columns and ${best.length} realignments are equally plausible`,
  };
}
