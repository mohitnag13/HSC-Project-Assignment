import type { PatientColumn } from '../domain/patient.js';

export type Severity = 'info' | 'warning' | 'error';

interface AnomalyDefinition {
  severity: Severity;
  title: string;
  description: string;
}

/**
 * Every data-quality finding the pipeline can report. `error` findings make a
 * row unusable (it is quarantined); `warning` and `info` findings are loaded
 * with the record and surfaced in the run report.
 */
export const ANOMALY_CATALOG = {
  ROW_REPAIRED: {
    severity: 'warning',
    title: 'Malformed row repaired',
    description:
      'The row had a different number of columns than the header (e.g. an unquoted "1,250.00"). It was realigned because exactly one interpretation produced a valid record.',
  },
  ROW_MALFORMED: {
    severity: 'error',
    title: 'Malformed row quarantined',
    description: 'The row could not be aligned with the header unambiguously, so it was quarantined rather than guessed.',
  },
  MISSING_REQUIRED: {
    severity: 'error',
    title: 'Required field missing',
    description: 'patient_id, first_name, last_name, dob, account_balance and last_modified are mandatory.',
  },
  PATIENT_ID_NORMALIZED: {
    severity: 'info',
    title: 'Patient ID normalised',
    description: 'Whitespace removed and letters upper-cased so that duplicates are matched reliably.',
  },
  MISSING_EMAIL: {
    severity: 'warning',
    title: 'Missing email',
    description: 'No email address in the export; loaded as null.',
  },
  MISSING_PHONE: {
    severity: 'warning',
    title: 'Missing phone',
    description: 'No phone number in the export; loaded as null.',
  },
  INVALID_EMAIL: {
    severity: 'warning',
    title: 'Malformed email',
    description:
      'The address is not well-formed. It is passed through (only lower-cased) for the SHC API to adjudicate; contact data is never guessed at.',
  },
  INVALID_PHONE: {
    severity: 'warning',
    title: 'Implausible phone',
    description: 'The number does not contain 7-15 digits. It is passed through unchanged.',
  },
  DOB_REFORMATTED: {
    severity: 'info',
    title: 'Date of birth normalised',
    description: 'Converted to ISO 8601 (YYYY-MM-DD).',
  },
  DOB_AMBIGUOUS: {
    severity: 'warning',
    title: 'Ambiguous date of birth',
    description:
      'Day and month are both <= 12, so the value reads validly either way. It was interpreted with its separator convention (MM/DD/YYYY for "/", DD-MM-YYYY for "-").',
  },
  DOB_INFERRED: {
    severity: 'warning',
    title: 'Date of birth order inferred',
    description: 'The value was impossible under its separator convention but valid with day and month swapped.',
  },
  DOB_INVALID: {
    severity: 'error',
    title: 'Invalid date of birth',
    description: 'Unrecognised format, not a real calendar date, or in the future.',
  },
  DOB_IMPLAUSIBLE: {
    severity: 'warning',
    title: 'Implausible date of birth',
    description: 'Date of birth is before 1900.',
  },
  BALANCE_CLEANED: {
    severity: 'info',
    title: 'Balance cleaned',
    description: 'Currency symbols, codes or thousands separators were stripped and the value parsed as a float.',
  },
  BALANCE_FOREIGN_CURRENCY: {
    severity: 'warning',
    title: 'Non-USD currency',
    description: 'The amount carried a non-USD currency marker. It was loaded at face value; no FX conversion is applied.',
  },
  BALANCE_NEGATIVE: {
    severity: 'info',
    title: 'Negative balance',
    description: 'Negative balance (credit) preserved as a negative float.',
  },
  BALANCE_INVALID: {
    severity: 'error',
    title: 'Invalid balance',
    description: 'account_balance could not be parsed as a number.',
  },
  TIMESTAMP_ASSUMED_UTC: {
    severity: 'warning',
    title: 'Timestamp without time zone',
    description: 'last_modified had no zone designator and was interpreted as UTC.',
  },
  TIMESTAMP_FUTURE: {
    severity: 'warning',
    title: 'Future timestamp',
    description: 'last_modified is in the future, which suggests clock skew on the source system.',
  },
  TIMESTAMP_INVALID: {
    severity: 'error',
    title: 'Invalid last_modified',
    description: 'last_modified is not a valid ISO 8601 timestamp, so recency cannot be established.',
  },
  DUPLICATE_SUPERSEDED: {
    severity: 'info',
    title: 'Duplicate superseded',
    description: 'An older version of a patient that appears more than once; the version with the latest last_modified wins.',
  },
  DUPLICATE_CONFLICT: {
    severity: 'warning',
    title: 'Conflicting duplicate',
    description: 'Versions of the same patient disagree on identity data, or another version could not be evaluated.',
  },
} as const satisfies Record<string, AnomalyDefinition>;

export type AnomalyCode = keyof typeof ANOMALY_CATALOG;

export interface Anomaly {
  code: AnomalyCode;
  severity: Severity;
  /** 1-based line number in the source file. */
  line: number;
  patientId: string | null;
  field?: PatientColumn;
  message: string;
  original?: string;
  normalized?: string | number | null;
}

export interface AnomalySummaryItem extends AnomalyDefinition {
  code: AnomalyCode;
  /** Rows affected (a row missing both names counts once for MISSING_REQUIRED). */
  count: number;
}

export function summarizeAnomalies(anomalies: Iterable<Anomaly>): AnomalySummaryItem[] {
  const rowsByCode = new Map<AnomalyCode, Set<number>>();
  for (const anomaly of anomalies) {
    const rows = rowsByCode.get(anomaly.code) ?? new Set<number>();
    rows.add(anomaly.line);
    rowsByCode.set(anomaly.code, rows);
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return [...rowsByCode.entries()]
    .map(([code, rows]) => ({ code, count: rows.size, ...ANOMALY_CATALOG[code] }))
    .sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}
