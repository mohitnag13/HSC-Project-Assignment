import { isPlausibleEmail, isPlausiblePhone } from '../domain/patient.js';
import { isValidCalendarDate } from '../etl/normalizers/date.js';

export interface FieldIssue {
  /** Position of the record inside the request's `patients` array. */
  index: number;
  patient_id: string | null;
  field: string;
  message: string;
}

const PATIENT_ID = /^P-\d{3,}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The mock SHC Platform's record schema. The platform, not the pipeline, is
 * the authority on what it accepts: the pipeline normalises what it safely
 * can and lets this check adjudicate the rest (e.g. malformed emails).
 */
export function validatePatient(value: unknown, index: number, today: Date = new Date()): FieldIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ index, patient_id: null, field: '(record)', message: 'must be a JSON object' }];
  }
  const record = value as Record<string, unknown>;
  const patientId = typeof record.patient_id === 'string' ? record.patient_id : null;
  const issues: FieldIssue[] = [];
  const reject = (field: string, message: string) => issues.push({ index, patient_id: patientId, field, message });

  if (!patientId || !PATIENT_ID.test(patientId)) reject('patient_id', 'must match P-<digits>');

  for (const field of ['first_name', 'last_name'] as const) {
    const name = record[field];
    if (typeof name !== 'string' || !name.trim()) reject(field, 'is required');
    else if (name.length > 100) reject(field, 'must be at most 100 characters');
  }

  const dob = record.dob;
  const dobParts = typeof dob === 'string' ? ISO_DATE.exec(dob) : null;
  if (!dobParts || !isValidCalendarDate(Number(dobParts[1]), Number(dobParts[2]), Number(dobParts[3]))) {
    reject('dob', 'must be an ISO 8601 date (YYYY-MM-DD)');
  } else if ((dob as string) > today.toISOString().slice(0, 10)) {
    reject('dob', 'cannot be in the future');
  }

  if (record.email !== null && (typeof record.email !== 'string' || !isPlausibleEmail(record.email))) {
    reject('email', 'must be a valid email address or null');
  }
  if (record.phone !== null && (typeof record.phone !== 'string' || !isPlausiblePhone(record.phone))) {
    reject('phone', 'must contain 7-15 digits or be null');
  }
  if (typeof record.account_balance !== 'number' || !Number.isFinite(record.account_balance)) {
    reject('account_balance', 'must be a number');
  }
  if (
    typeof record.last_modified !== 'string' ||
    !ISO_TIMESTAMP.test(record.last_modified) ||
    Number.isNaN(Date.parse(record.last_modified))
  ) {
    reject('last_modified', 'must be an ISO 8601 timestamp with a time zone');
  }
  return issues;
}
