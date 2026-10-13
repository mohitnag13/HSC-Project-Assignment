import { parse } from 'csv-parse/sync';
import { PATIENT_COLUMNS, type PatientColumn } from '../domain/patient.js';

export class CsvFormatError extends Error {
  override name = 'CsvFormatError';
}

export interface SourceRow {
  /** 1-based line number where the record ends in the source file. */
  line: number;
  fields: string[];
  /** Set when the line could not be tokenised at all; the row is quarantined. */
  parseError?: string;
}

export interface CsvDocument {
  header: string[];
  columnIndex: Record<PatientColumn, number>;
  rows: SourceRow[];
}

const HEADER_ALIASES: Record<string, PatientColumn> = {
  id: 'patient_id',
  firstname: 'first_name',
  givenname: 'first_name',
  lastname: 'last_name',
  surname: 'last_name',
  familyname: 'last_name',
  dateofbirth: 'dob',
  birthdate: 'dob',
  emailaddress: 'email',
  phonenumber: 'phone',
  telephone: 'phone',
  balance: 'account_balance',
  updatedat: 'last_modified',
  lastupdated: 'last_modified',
  modifiedat: 'last_modified',
};

/** Canonical names with separators removed, so "Patient-ID" and "E-mail" still count as exact. */
const CANONICAL_BY_KEY = new Map<string, PatientColumn>(PATIENT_COLUMNS.map((column) => [column.replace(/_/g, ''), column]));

export function normalizeHeaderName(name: string): string {
  return name.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function resolveColumn(name: string): { column: PatientColumn; exact: boolean } | undefined {
  const key = name.replace(/_/g, '');
  const canonical = CANONICAL_BY_KEY.get(key);
  if (canonical) return { column: canonical, exact: true };
  const alias = HEADER_ALIASES[key];
  return alias ? { column: alias, exact: false } : undefined;
}

/**
 * Maps header positions to fields. Canonical names win over alternatives, so
 * an unrelated "id" column cannot hijack "patient_id"; two columns competing
 * for the same field at the same priority is ambiguous and rejected.
 */
function mapColumns(header: readonly string[], labels: readonly string[]): Record<PatientColumn, number> {
  const columnIndex: Partial<Record<PatientColumn, number>> = {};
  const exactColumns = new Set<PatientColumn>();
  for (const exactPass of [true, false]) {
    header.forEach((name, index) => {
      const match = resolveColumn(name);
      if (!match || match.exact !== exactPass) return;
      const taken = columnIndex[match.column];
      if (taken === undefined) {
        columnIndex[match.column] = index;
        if (exactPass) exactColumns.add(match.column);
        return;
      }
      if (!exactPass && exactColumns.has(match.column)) return;
      throw new CsvFormatError(
        `Columns "${labels[taken]}" and "${labels[index]}" both map to ${match.column}; rename or remove one.`,
      );
    });
  }
  const missing = PATIENT_COLUMNS.filter((column) => columnIndex[column] === undefined);
  if (missing.length > 0) {
    throw new CsvFormatError(`The header is missing required column(s): ${missing.join(', ')}.`);
  }
  return columnIndex as Record<PatientColumn, number>;
}

function parseWhole(input: string): SourceRow[] {
  const records = parse(input, {
    info: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    skip_records_with_empty_values: true,
    trim: true,
  }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  return records.map(({ record, info }) => ({ line: info.lines, fields: record }));
}

/**
 * Fallback for files the tokenizer rejects as a whole (e.g. `"Smith"Jr`):
 * read line by line, so one broken line is quarantined instead of the whole
 * file failing. The patient schema has no multi-line fields, so a line is a record.
 */
function parseLineByLine(input: string): SourceRow[] {
  const rows: SourceRow[] = [];
  input.split('\n').forEach((text, index) => {
    if (/^[\s,]*$/.test(text)) return;
    const line = index + 1;
    try {
      const [fields] = parse(text, { relax_column_count: true, relax_quotes: true, trim: true }) as string[][];
      if (fields && fields.some((field) => field !== '')) rows.push({ line, fields });
    } catch (error) {
      rows.push({ line, fields: [text], parseError: (error as Error).message.replace(/\s*at line \d+\s*$/, '') });
    }
  });
  return rows;
}

/**
 * Tokenises the export with an RFC 4180 parser in "relaxed" mode: rows with
 * the wrong number of columns are kept (and repaired or quarantined later)
 * instead of aborting the whole file.
 */
export function readCsv(text: string): CsvDocument {
  // Mixed CR/LF endings confuse line numbering; normalise them first.
  const input = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let parsed: SourceRow[];
  try {
    parsed = parseWhole(input);
  } catch {
    parsed = parseLineByLine(input);
  }

  const [headerRow, ...rows] = parsed;
  if (!headerRow) throw new CsvFormatError('The file is empty.');
  if (headerRow.parseError) throw new CsvFormatError(`The header row could not be parsed: ${headerRow.parseError}`);

  const header = headerRow.fields.map(normalizeHeaderName);
  // A trailing delimiter on the header adds unnamed columns that carry no data.
  while (header.length > 0 && header.at(-1) === '') header.pop();
  return { header, columnIndex: mapColumns(header, headerRow.fields), rows };
}
