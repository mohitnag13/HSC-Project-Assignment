import { isPlausibleEmail, isPlausiblePhone, type PatientColumn, type PatientRecord } from '../domain/patient.js';
import { ANOMALY_CATALOG, type Anomaly, type AnomalyCode } from './anomalies.js';
import { normalizeDob } from './normalizers/date.js';
import { BASE_CURRENCY, parseMoney } from './normalizers/money.js';
import { cleanText, normalizePatientId } from './normalizers/text.js';
import { parseTimestamp } from './normalizers/timestamp.js';
import type { RowValues } from './rowRepair.js';

export interface NormalizedRow {
  record: Partial<PatientRecord>;
  issues: Anomaly[];
  /** Epoch milliseconds of last_modified, or null when it is unusable. */
  lastModifiedMs: number | null;
  /** Currency detected in account_balance (null = no marker, assumed base currency). */
  currency: string | null;
  dobFormat: string | null;
}

/** Clock-skew tolerance before a last_modified value is considered "in the future". */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Normalises one aligned row into the canonical record and collects every
 * anomaly found along the way. Never throws: problems become `error`
 * anomalies, and the caller decides what an unusable row means.
 */
export function normalizeRow(values: RowValues, line: number, now: Date): NormalizedRow {
  const record: Partial<PatientRecord> = {};
  const issues: Anomaly[] = [];

  const flag = (
    code: AnomalyCode,
    message: string,
    details: { field?: PatientColumn; original?: string; normalized?: string | number | null } = {},
  ) => {
    issues.push({
      code,
      severity: ANOMALY_CATALOG[code].severity,
      line,
      patientId: record.patient_id ?? null,
      message,
      ...details,
    });
  };
  const missing = (field: PatientColumn) => flag('MISSING_REQUIRED', `${field} is empty`, { field });

  // patient_id
  const patientId = normalizePatientId(values.patient_id);
  if (!patientId) {
    missing('patient_id');
  } else {
    record.patient_id = patientId;
    if (patientId !== values.patient_id.trim()) {
      flag('PATIENT_ID_NORMALIZED', `"${values.patient_id}" -> "${patientId}"`, {
        field: 'patient_id',
        original: values.patient_id,
        normalized: patientId,
      });
    }
  }

  // names: trimmed only, never re-cased ("McDonald", "de la Cruz")
  for (const field of ['first_name', 'last_name'] as const) {
    const name = cleanText(values[field]);
    if (name) record[field] = name;
    else missing(field);
  }

  // dob
  let dobFormat: string | null = null;
  const rawDob = values.dob.trim();
  if (!rawDob) {
    missing('dob');
  } else {
    const dob = normalizeDob(rawDob, now);
    if (!dob.ok) {
      flag('DOB_INVALID', dob.reason, { field: 'dob', original: rawDob });
    } else {
      record.dob = dob.iso;
      dobFormat = dob.format;
      if (dob.iso !== rawDob) {
        flag('DOB_REFORMATTED', `"${rawDob}" read as ${dob.format} -> ${dob.iso}`, {
          field: 'dob',
          original: rawDob,
          normalized: dob.iso,
        });
      }
      if (dob.ambiguous) {
        flag('DOB_AMBIGUOUS', `"${rawDob}" is valid either way; interpreted as ${dob.format} -> ${dob.iso}`, {
          field: 'dob',
          original: rawDob,
          normalized: dob.iso,
        });
      }
      if (dob.inferred) {
        flag('DOB_INFERRED', `"${rawDob}" only makes sense as ${dob.format} -> ${dob.iso}`, {
          field: 'dob',
          original: rawDob,
          normalized: dob.iso,
        });
      }
      if (dob.beforeMinYear) flag('DOB_IMPLAUSIBLE', `date of birth ${dob.iso} is before 1900`, { field: 'dob' });
    }
  }

  // email (optional)
  const email = cleanText(values.email).toLowerCase();
  if (!email) {
    record.email = null;
    flag('MISSING_EMAIL', 'email is missing; loaded as null', { field: 'email', normalized: null });
  } else {
    record.email = email;
    if (!isPlausibleEmail(email)) {
      flag('INVALID_EMAIL', `"${email}" is not a well-formed address`, { field: 'email', original: values.email });
    }
  }

  // phone (optional)
  const phone = cleanText(values.phone);
  if (!phone) {
    record.phone = null;
    flag('MISSING_PHONE', 'phone is missing; loaded as null', { field: 'phone', normalized: null });
  } else {
    record.phone = phone;
    if (!isPlausiblePhone(phone)) {
      flag('INVALID_PHONE', `"${phone}" does not contain 7-15 digits`, { field: 'phone', original: values.phone });
    }
  }

  // account_balance
  let currency: string | null = null;
  const rawBalance = values.account_balance.trim();
  if (!rawBalance) {
    missing('account_balance');
  } else {
    const money = parseMoney(rawBalance);
    if (!money.ok) {
      flag('BALANCE_INVALID', money.reason, { field: 'account_balance', original: rawBalance });
    } else {
      record.account_balance = money.value;
      currency = money.currency;
      if (money.cleaned) {
        flag('BALANCE_CLEANED', `"${rawBalance}" -> ${money.value}`, {
          field: 'account_balance',
          original: rawBalance,
          normalized: money.value,
        });
      }
      if (money.currency && money.currency !== BASE_CURRENCY) {
        flag(
          'BALANCE_FOREIGN_CURRENCY',
          `"${rawBalance}" is denominated in ${money.currency}; loaded as ${money.value} without conversion`,
          { field: 'account_balance', original: rawBalance, normalized: money.value },
        );
      }
      if (money.value < 0) {
        flag('BALANCE_NEGATIVE', `negative balance ${money.value} preserved`, {
          field: 'account_balance',
          normalized: money.value,
        });
      }
    }
  }

  // last_modified
  let lastModifiedMs: number | null = null;
  const rawTimestamp = values.last_modified.trim();
  if (!rawTimestamp) {
    missing('last_modified');
  } else {
    const timestamp = parseTimestamp(rawTimestamp);
    if (!timestamp.ok) {
      flag('TIMESTAMP_INVALID', timestamp.reason, { field: 'last_modified', original: rawTimestamp });
    } else {
      record.last_modified = timestamp.iso;
      lastModifiedMs = timestamp.epochMs;
      if (timestamp.assumedUtc) {
        flag('TIMESTAMP_ASSUMED_UTC', `"${rawTimestamp}" has no time zone; read as ${timestamp.iso}`, {
          field: 'last_modified',
          original: rawTimestamp,
          normalized: timestamp.iso,
        });
      }
      if (timestamp.epochMs > now.getTime() + FUTURE_TOLERANCE_MS) {
        flag('TIMESTAMP_FUTURE', `last_modified ${timestamp.iso} is in the future`, { field: 'last_modified' });
      }
    }
  }

  return { record, issues, lastModifiedMs, currency, dobFormat };
}

export function isCompleteRecord(record: Partial<PatientRecord>): record is PatientRecord {
  return (
    record.patient_id !== undefined &&
    record.first_name !== undefined &&
    record.last_name !== undefined &&
    record.dob !== undefined &&
    record.email !== undefined &&
    record.phone !== undefined &&
    record.account_balance !== undefined &&
    record.last_modified !== undefined
  );
}
