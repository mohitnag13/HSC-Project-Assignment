import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CsvFormatError } from '../src/etl/csvReader.js';
import { alignRow } from '../src/etl/rowRepair.js';
import { transformCsv } from '../src/etl/transform.js';
import { buildRunReport } from '../src/reporting/runReport.js';
import { generateDataset } from '../src/tools/generateDataset.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const HEADER = 'patient_id,first_name,last_name,dob,email,phone,account_balance,last_modified';
const sampleCsv = readFileSync(join(import.meta.dirname, '..', 'data', 'patients.csv'), 'utf8');

const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const codesOf = (result: ReturnType<typeof transformCsv>, line: number) =>
  result.rows.find((row) => row.line === line)?.issues.map((issue) => issue.code) ?? [];

describe('transformCsv on the GlobalHealth sample export', () => {
  const result = transformCsv(sampleCsv, { now: NOW });

  it('produces exactly the expected clean records', () => {
    expect(result.records).toEqual([
      { patient_id: 'P-1001', first_name: 'John', last_name: 'Doe', dob: '1980-05-15', email: 'john.doe@newemail.com', phone: '555-0100', account_balance: 0, last_modified: '2026-10-05T14:20:00.000Z' },
      { patient_id: 'P-1002', first_name: 'Jane', last_name: 'Smith', dob: '1992-12-31', email: null, phone: null, account_balance: 1250, last_modified: '2026-10-02T11:30:00.000Z' },
      { patient_id: 'P-1003', first_name: 'Alice', last_name: 'Jones', dob: '1975-04-25', email: 'alice.j@email.com', phone: '555-0102', account_balance: 300, last_modified: '2026-10-03T09:15:00.000Z' },
      { patient_id: 'P-1004', first_name: 'Bob', last_name: 'Brown', dob: '1960-11-02', email: 'bob.b@email.com', phone: '555-0103', account_balance: 2450.75, last_modified: '2026-10-01T10:00:00.000Z' },
      { patient_id: 'P-1005', first_name: 'Charlie', last_name: 'Davis', dob: '1988-07-04', email: null, phone: '555-0104', account_balance: 0, last_modified: '2026-10-01T10:00:00.000Z' },
      { patient_id: 'P-1006', first_name: 'Diana', last_name: 'Prince', dob: '1985-08-20', email: 'diana.p@email.com', phone: null, account_balance: 45.5, last_modified: '2026-09-15T08:00:00.000Z' },
      { patient_id: 'P-1007', first_name: 'Evan', last_name: 'Wright', dob: '1999-08-15', email: 'evan.w@email.com', phone: '555-0105', account_balance: -15, last_modified: '2026-10-06T16:45:00.000Z' },
    ]);
  });

  it('reports the anomalies found in the sample', () => {
    expect(result.stats).toMatchObject({
      totalRows: 9,
      recordsReady: 7,
      rejectedRows: 0,
      repairedRows: 1,
      duplicateRowsRemoved: 2,
      patientsWithDuplicates: 2,
      missingEmail: 2,
      missingPhone: 2,
      datesNormalized: 5,
      ambiguousDates: 1,
      foreignCurrencyBalances: 1,
      negativeBalances: 1,
    });
  });

  it('repairs the unquoted "1,250.00" on line 3 (P-1002)', () => {
    const row = result.rows.find((candidate) => candidate.line === 3);
    expect(row?.sourceFields).toHaveLength(9);
    expect(row?.source?.account_balance).toBe('1,250.00');
    expect(codesOf(result, 3)).toEqual(expect.arrayContaining(['ROW_REPAIRED', 'MISSING_EMAIL', 'MISSING_PHONE', 'DOB_REFORMATTED']));
  });

  it('keeps the latest version of each duplicate, even when it appears first in the file', () => {
    const p1003 = result.duplicates.find((group) => group.patientId === 'P-1003');
    expect(p1003).toMatchObject({ keptLine: 4, resolution: 'latest_kept' });
    expect(result.rows.find((row) => row.line === 9)).toMatchObject({ status: 'superseded', supersededBy: 4 });

    const p1001 = result.duplicates.find((group) => group.patientId === 'P-1001');
    expect(p1001).toMatchObject({ keptLine: 5, changedFields: ['email', 'account_balance'] });
  });

  it('notes the currency change between P-1003 versions and flags the euro amount', () => {
    expect(result.duplicates.find((group) => group.patientId === 'P-1003')?.notes.join(' ')).toContain('Currency marker');
    expect(codesOf(result, 4)).toContain('BALANCE_FOREIGN_CURRENCY');
  });

  it('flags the ambiguous 07/04/1988', () => {
    expect(codesOf(result, 7)).toContain('DOB_AMBIGUOUS');
  });
});

describe('transformCsv edge cases', () => {
  it('breaks last_modified ties in favour of the later row', () => {
    const result = transformCsv(
      csv('P-1,A,B,1980-01-01,old@x.com,555-0100,1,2026-01-01T00:00:00Z', 'P-1,A,B,1980-01-01,new@x.com,555-0100,1,2026-01-01T00:00:00Z'),
      { now: NOW },
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.email).toBe('new@x.com');
  });

  it('withholds a patient whose newest version is invalid instead of loading stale data', () => {
    const result = transformCsv(
      csv('P-1,A,B,1980-01-01,a@x.com,555-0100,1,2026-01-01T00:00:00Z', 'P-1,A,B,not-a-date,a@x.com,555-0100,1,2026-02-01T00:00:00Z'),
      { now: NOW },
    );
    expect(result.records).toHaveLength(0);
    expect(result.duplicates[0]).toMatchObject({ resolution: 'latest_invalid', keptLine: null });
    expect(result.rows.map((row) => row.status)).toEqual(['superseded', 'rejected']);
  });

  it('matches duplicate IDs case- and whitespace-insensitively', () => {
    const result = transformCsv(
      csv(' p-1 ,A,B,1980-01-01,a@x.com,555-0100,1,2026-01-01T00:00:00Z', 'P-1,A,B,1980-01-01,b@x.com,555-0100,1,2026-03-01T00:00:00Z'),
      { now: NOW },
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.email).toBe('b@x.com');
  });

  it('handles BOM, CRLF line endings, blank lines and reordered columns', () => {
    const text = '﻿last_modified,patient_id,first_name,last_name,dob,email,phone,account_balance\r\n\r\n2026-01-01T00:00:00Z,P-9,Ann,Lee,01/02/1990,,555-0199,"$1,000.00"\r\n';
    const result = transformCsv(text, { now: NOW });
    expect(result.records).toEqual([
      { patient_id: 'P-9', first_name: 'Ann', last_name: 'Lee', dob: '1990-01-02', email: null, phone: '555-0199', account_balance: 1000, last_modified: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('quarantines rows that cannot be realigned unambiguously', () => {
    const result = transformCsv(csv('P-1,A,B,1980-01-01,a@x.com,555-0100,1,2,3,2026-01-01T00:00:00Z'), { now: NOW });
    expect(result.records).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({ status: 'rejected' });
    expect(codesOf(result, 2)).toEqual(['ROW_MALFORMED']);
  });

  it('quarantines rows with invalid required fields and keeps the rest', () => {
    const result = transformCsv(
      csv('P-1,A,B,02/30/1990,a@x.com,555-0100,1,2026-01-01T00:00:00Z', 'P-2,C,D,1990-01-01,c@x.com,555-0100,300;00,2026-01-01T00:00:00Z', 'P-3,E,F,1990-01-01,,,5,2026-01-01T00:00:00Z'),
      { now: NOW },
    );
    expect(result.records.map((record) => record.patient_id)).toEqual(['P-3']);
    expect(codesOf(result, 2)).toContain('DOB_INVALID');
    expect(codesOf(result, 3)).toContain('BALANCE_INVALID');
  });

  it('passes malformed emails through with a warning for the API to adjudicate', () => {
    const result = transformCsv(csv('P-1,A,B,1980-01-01,John.Doe@,555-0100,1,2026-01-01T00:00:00Z'), { now: NOW });
    expect(result.records[0]?.email).toBe('john.doe@');
    expect(codesOf(result, 2)).toContain('INVALID_EMAIL');
  });

  it('fails fast when a required column is missing from the header', () => {
    expect(() => transformCsv('patient_id,first_name\nP-1,A\n')).toThrow(CsvFormatError);
  });

  it('prefers real column names over alternatives, so an unrelated "id" column cannot hijack patient_id', () => {
    const result = transformCsv(
      [
        `id,${HEADER}`,
        '1,P-1,A,B,1980-01-01,old@x.com,555-0100,1,2026-01-01T00:00:00Z',
        '2,P-1,A,B,1980-01-01,new@x.com,555-0100,1,2026-02-01T00:00:00Z',
      ].join('\n'),
      { now: NOW },
    );
    expect(result.records.map((record) => `${record.patient_id}:${record.email}`)).toEqual(['P-1:new@x.com']);
    expect(result.duplicates).toHaveLength(1);
  });

  it('recognises punctuation variants of column names', () => {
    const text = ['Patient-ID,First Name,Last Name,DOB,E-mail,Phone,Account Balance,Last-Modified', 'P-1,A,B,1980-01-01,a@x.com,555-0100,1,2026-01-01T00:00:00Z'].join('\n');
    expect(transformCsv(text, { now: NOW }).records).toHaveLength(1);
  });

  it('rejects a header where two columns compete for the same field', () => {
    const competing = 'patient_id,first_name,last_name,dob,email,phone,account_balance,updated_at,last_updated\n';
    expect(() => transformCsv(competing)).toThrow(/both map to last_modified/);
    expect(() => transformCsv(`${HEADER},email\n`)).toThrow(/both map to email/);
  });

  it('ignores trailing delimiters on the header or on the data rows', () => {
    const row = 'P-1,A,B,1980-01-01,a@x.com,555-0100,1,2026-01-01T00:00:00Z';
    expect(transformCsv(`${HEADER}\n${row},\n`, { now: NOW }).records).toHaveLength(1);
    expect(transformCsv(`${HEADER},\n${row}\n`, { now: NOW }).records).toHaveLength(1);
  });

  it('quarantines only the line with broken quoting, not the whole file', () => {
    const result = transformCsv(
      csv('P-1,A,"Smith"Jr,1980-01-01,a@x.com,555-0100,1,2026-01-01T00:00:00Z', 'P-2,C,D,1990-01-01,c@x.com,555-0100,2,2026-01-01T00:00:00Z'),
      { now: NOW },
    );
    expect(result.records.map((record) => record.patient_id)).toEqual(['P-2']);
    expect(result.rows[0]).toMatchObject({ line: 2, patientId: 'P-1', status: 'rejected' });
    expect(result.rows[0]?.issues[0]).toMatchObject({ code: 'ROW_MALFORMED', message: expect.stringContaining('could not be parsed as CSV') });
  });

  it('counts anomalies per affected row', () => {
    const result = transformCsv(csv('P-1,,,1980-01-01,a@x.com,555-0100,1,2026-01-01T00:00:00Z'), { now: NOW });
    expect(result.anomalySummary.find((item) => item.code === 'MISSING_REQUIRED')?.count).toBe(1);
  });

  it('keeps patient data out of run_report.json', () => {
    const result = transformCsv(csv('P-9,A,B,02/30/1990,a@x.com,555-0100,1,2026-01-01T00:00:00Z'), { now: NOW });
    const report = buildRunReport({ sourceFile: 'x.csv', transform: result, summary: null });
    expect(report.transform.rejected_rows).toEqual([{ line: 2, patient_id: 'P-9', errors: ['DOB_INVALID (dob)'] }]);
    expect(JSON.stringify(report)).not.toContain('02/30/1990');
  });
});

describe('alignRow', () => {
  const layout = { header: HEADER.split(','), columnIndex: { patient_id: 0, first_name: 1, last_name: 2, dob: 3, email: 4, phone: 5, account_balance: 6, last_modified: 7 } };

  it('re-joins an unquoted thousands separator into account_balance', () => {
    const result = alignRow(['P-1', 'A', 'B', '1980-01-01', '', '', '1', '250.00', '2026-01-01T00:00:00Z'], layout);
    expect(result).toMatchObject({ ok: true, values: { account_balance: '1,250.00' }, repair: { kind: 'merged', columns: ['account_balance'] } });
  });

  it('refuses to guess when an unquoted comma could belong to either name column', () => {
    // "A,Smith" + "Jr." and "A" + "Smith, Jr." are both valid records.
    const result = alignRow(['P-1', 'A', 'Smith', ' Jr.', '1980-01-01', 'a@x.com', '555-0100', '1', '2026-01-01T00:00:00Z'], layout);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('2 realignments are equally plausible') });
  });

  it('treats a dropped phone column as absent', () => {
    const result = alignRow(['P-1', 'A', 'B', '1980-01-01', 'a@x.com', '$5.00', '2026-01-01T00:00:00Z'], layout);
    expect(result).toMatchObject({ ok: true, values: { email: 'a@x.com', phone: '', account_balance: '$5.00' }, repair: { kind: 'inserted', columns: ['phone'] } });
  });

  it('does not let an odd phone number block an otherwise unambiguous repair', () => {
    const result = alignRow(['P-1', 'A', 'B', '1980-01-01', 'a@x.com', '12345', '1', '250.00', '2026-01-01T00:00:00Z'], layout);
    expect(result).toMatchObject({ ok: true, values: { phone: '12345', account_balance: '1,250.00' } });
  });

  it('treats readings that produce identical values as one reading', () => {
    // Either optional column can be "the missing one"; both give empty email and phone.
    const result = alignRow(['P-1', 'A', 'B', '1980-01-01', '', '$5.00', '2026-01-01T00:00:00Z'], layout);
    expect(result).toMatchObject({ ok: true, values: { email: '', phone: '', account_balance: '$5.00' } });
  });
});

describe('generateDataset', () => {
  it('is deterministic per seed and exercises every anomaly class', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const first = generateDataset({ patients: 400, seed: 11, now });
    expect(generateDataset({ patients: 400, seed: 11, now }).csv).toBe(first.csv);

    const result = transformCsv(first.csv, { now });
    expect(result.stats.totalRows).toBe(first.rows);
    expect(result.stats.duplicateRowsRemoved).toBeGreaterThan(0);
    expect(result.stats.repairedRows).toBeGreaterThan(0);
    expect(result.stats.datesNormalized).toBeGreaterThan(0);
    expect(result.records.length).toBeGreaterThan(380);
  });
});
