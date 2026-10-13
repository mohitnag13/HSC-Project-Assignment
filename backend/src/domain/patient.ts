/**
 * Canonical patient record accepted by the SHC Platform API. Every stage of
 * the pipeline converges on this shape.
 */
export const PATIENT_COLUMNS = [
  'patient_id',
  'first_name',
  'last_name',
  'dob',
  'email',
  'phone',
  'account_balance',
  'last_modified',
] as const;

export type PatientColumn = (typeof PATIENT_COLUMNS)[number];

export interface PatientRecord {
  patient_id: string;
  first_name: string;
  last_name: string;
  /** ISO 8601 calendar date (YYYY-MM-DD). */
  dob: string;
  email: string | null;
  phone: string | null;
  account_balance: number;
  /** ISO 8601 UTC timestamp. */
  last_modified: string;
}

/**
 * Pragmatic email check. RFC 5322 allows far more; the goal here is to catch
 * export corruption ("john.doe@", "jane smith@x.com"), not exotic addresses.
 * Domain labels exclude ".", so a value splits only one way and matching stays
 * linear even on hostile input (a 200 KB cell no longer stalls the run).
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** RFC 5321 caps an address at 254 characters. */
export const MAX_EMAIL_LENGTH = 254;

export function isPlausibleEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value);
}

const PHONE_CHARACTERS = /^[0-9+().\-\s]+$/;

/** Phone numbers must use phone characters only and carry 7-15 digits (E.164 maximum). */
export function isPlausiblePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '').length;
  return PHONE_CHARACTERS.test(value) && digits >= 7 && digits <= 15;
}
