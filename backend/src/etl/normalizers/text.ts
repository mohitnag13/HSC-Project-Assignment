/** Trims and collapses internal runs of whitespace. Names are otherwise left exactly as exported. */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Patient IDs are compared case-insensitively ("p-1001" and "P-1001" are the same patient). */
export function normalizePatientId(value: string): string {
  return cleanText(value).replace(/\s/g, '').toUpperCase();
}
