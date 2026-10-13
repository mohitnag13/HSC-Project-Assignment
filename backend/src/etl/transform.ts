import { PATIENT_COLUMNS, type PatientColumn, type PatientRecord } from '../domain/patient.js';
import {
  ANOMALY_CATALOG,
  summarizeAnomalies,
  type Anomaly,
  type AnomalyCode,
  type AnomalySummaryItem,
} from './anomalies.js';
import { readCsv, type CsvDocument, type SourceRow } from './csvReader.js';
import { pickLatestVersion } from './dedupe.js';
import { isCompleteRecord, normalizeRow } from './normalizeRow.js';
import { normalizePatientId } from './normalizers/text.js';
import { alignRow, type RowValues } from './rowRepair.js';

export type RowStatus = 'loaded' | 'superseded' | 'rejected';

export interface RowResult {
  /** 1-based line number in the source file. */
  line: number;
  patientId: string | null;
  status: RowStatus;
  /** Fields exactly as tokenised from the file. */
  sourceFields: string[];
  /** Raw values aligned to columns (after any repair); null when the row is malformed. */
  source: RowValues | null;
  /** Normalised values; partial when the row is rejected. */
  record: Partial<PatientRecord>;
  issues: Anomaly[];
  supersededBy: number | null;
  currency: string | null;
  dobFormat: string | null;
}

export interface DuplicateVersion {
  line: number;
  status: RowStatus;
  lastModified: string | null;
  record: Partial<PatientRecord>;
  currency: string | null;
}

export interface DuplicateGroup {
  patientId: string;
  keptLine: number | null;
  resolution: 'latest_kept' | 'latest_invalid' | 'no_usable_timestamp';
  /** Newest first. */
  versions: DuplicateVersion[];
  /** Fields whose normalised value differs between versions (last_modified excluded). */
  changedFields: PatientColumn[];
  notes: string[];
}

export interface TransformStats {
  totalRows: number;
  recordsReady: number;
  rejectedRows: number;
  repairedRows: number;
  malformedRows: number;
  duplicateRowsRemoved: number;
  patientsWithDuplicates: number;
  /** Among records ready to load. */
  missingEmail: number;
  /** Among records ready to load. */
  missingPhone: number;
  datesNormalized: number;
  ambiguousDates: number;
  balancesCleaned: number;
  foreignCurrencyBalances: number;
  negativeBalances: number;
  invalidEmails: number;
}

export interface TransformResult {
  header: string[];
  /** Clean, de-duplicated records in order of each patient's first appearance. */
  records: PatientRecord[];
  rows: RowResult[];
  duplicates: DuplicateGroup[];
  anomalySummary: AnomalySummaryItem[];
  stats: TransformStats;
}

export interface TransformOptions {
  /** Reference time for "future date" checks; injectable for deterministic tests. */
  now?: Date;
}

interface WorkingRow extends RowResult {
  lastModifiedMs: number | null;
  usable: boolean;
}

function anomaly(code: AnomalyCode, row: Pick<RowResult, 'line' | 'patientId'>, message: string, field?: PatientColumn): Anomaly {
  return { code, severity: ANOMALY_CATALOG[code].severity, line: row.line, patientId: row.patientId, message, ...(field ? { field } : {}) };
}

function quarantine(line: number, fields: string[], patientId: string | null, reason: string): WorkingRow {
  return {
    line,
    patientId,
    status: 'rejected',
    sourceFields: fields,
    source: null,
    record: {},
    issues: [anomaly('ROW_MALFORMED', { line, patientId }, reason)],
    supersededBy: null,
    currency: null,
    dobFormat: null,
    lastModifiedMs: null,
    usable: false,
  };
}

function buildRow(sourceRow: SourceRow, document: CsvDocument, now: Date): WorkingRow {
  const { line, fields } = sourceRow;
  if (sourceRow.parseError) {
    // Untokenisable line: a naive split is still good enough to report which patient it was.
    const naive = (fields[0] ?? '').split(',');
    const patientId = normalizePatientId(naive[document.columnIndex.patient_id] ?? '') || null;
    return quarantine(line, fields, patientId, `the line could not be parsed as CSV (${sourceRow.parseError})`);
  }

  const aligned = alignRow(fields, document);
  if (!aligned.ok) {
    return quarantine(line, fields, normalizePatientId(fields[document.columnIndex.patient_id] ?? '') || null, aligned.reason);
  }

  const normalized = normalizeRow(aligned.values, line, now);
  const patientId = normalized.record.patient_id ?? null;
  if (aligned.repair) {
    normalized.issues.unshift(anomaly('ROW_REPAIRED', { line, patientId }, aligned.repair.detail, aligned.repair.columns[0]));
  }
  const usable = isCompleteRecord(normalized.record) && !normalized.issues.some((issue) => issue.severity === 'error');
  return {
    line,
    patientId,
    status: usable ? 'loaded' : 'rejected',
    sourceFields: fields,
    source: aligned.values,
    record: normalized.record,
    issues: normalized.issues,
    supersededBy: null,
    currency: normalized.currency,
    dobFormat: normalized.dobFormat,
    lastModifiedMs: normalized.lastModifiedMs,
    usable,
  };
}

function describeGroup(patientId: string, versions: WorkingRow[], winner: WorkingRow | null): DuplicateGroup {
  const newestFirst = [...versions].sort(
    (a, b) => (b.lastModifiedMs ?? -Infinity) - (a.lastModifiedMs ?? -Infinity) || b.line - a.line,
  );
  const changedFields = PATIENT_COLUMNS.filter((column) => {
    if (column === 'last_modified') return false;
    const distinct = new Set(
      versions.map((version) => version.record[column]).filter((value) => value !== undefined).map((value) => JSON.stringify(value)),
    );
    return distinct.size > 1;
  });

  const notes: string[] = [];
  const currencies = new Set(versions.map((version) => version.currency ?? 'USD'));
  if (currencies.size > 1) {
    notes.push(
      `Currency marker on account_balance changes between versions (${versions
        .map((version) => `line ${version.line}: ${version.currency ?? 'none'}`)
        .join(', ')}); confirm the intended currency with the client.`,
    );
  }
  if (changedFields.includes('dob')) {
    notes.push('Versions disagree on date of birth; verify the patient identity before relying on the loaded record.');
  }
  if (winner && !winner.usable) {
    notes.push(
      `The newest version (line ${winner.line}) is invalid, so older versions were withheld to avoid loading stale data.`,
    );
  }

  return {
    patientId,
    keptLine: winner?.usable ? winner.line : null,
    resolution: winner === null ? 'no_usable_timestamp' : winner.usable ? 'latest_kept' : 'latest_invalid',
    versions: newestFirst.map((version) => ({
      line: version.line,
      status: version.status,
      lastModified: version.record.last_modified ?? null,
      record: version.record,
      currency: version.currency,
    })),
    changedFields,
    notes,
  };
}

/**
 * Extract + transform: parse the legacy CSV, repair malformed rows, normalise
 * every field, and keep only the most recently modified version of each
 * patient. Pure and synchronous: no I/O, so the CLI, the container and the
 * console UI all share exactly the same logic.
 */
export function transformCsv(text: string, options: TransformOptions = {}): TransformResult {
  const now = options.now ?? new Date();
  const document = readCsv(text);
  const rows = document.rows.map((source) => buildRow(source, document, now));

  // Group comparable rows by patient; Map order = first appearance in the file.
  const groups = new Map<string, WorkingRow[]>();
  for (const row of rows) {
    if (!row.patientId || row.source === null) continue;
    const group = groups.get(row.patientId);
    if (group) group.push(row);
    else groups.set(row.patientId, [row]);
  }

  const records: PatientRecord[] = [];
  const duplicates: DuplicateGroup[] = [];
  const loadedByPatient = new Map<string, WorkingRow>();

  for (const [patientId, versions] of groups) {
    const winner = pickLatestVersion(versions);
    for (const version of versions) {
      if (version === winner || !version.usable || !winner) continue;
      version.status = 'superseded';
      version.supersededBy = winner.line;
      const why =
        winner.lastModifiedMs === version.lastModifiedMs
          ? `same last_modified as line ${winner.line}; the later row wins`
          : `line ${winner.line} has a newer last_modified (${winner.record.last_modified ?? 'n/a'} > ${version.record.last_modified ?? 'n/a'})`;
      version.issues.push(
        anomaly(
          'DUPLICATE_SUPERSEDED',
          version,
          winner.usable ? `superseded: ${why}` : `superseded: ${why}, but that version is invalid so ${patientId} is not loaded`,
        ),
      );
    }
    if (winner?.usable) {
      winner.status = 'loaded';
      records.push(winner.record as PatientRecord);
      loadedByPatient.set(patientId, winner);
    }
    if (versions.length > 1) {
      const group = describeGroup(patientId, versions, winner);
      duplicates.push(group);
      if (winner?.usable && group.changedFields.includes('dob')) {
        winner.issues.push(anomaly('DUPLICATE_CONFLICT', winner, 'versions of this patient disagree on date of birth', 'dob'));
      }
    }
  }

  // A quarantined row whose recency is unknown may be newer than what we load.
  for (const row of rows) {
    if (row.status !== 'rejected' || row.lastModifiedMs !== null || !row.patientId) continue;
    const loaded = loadedByPatient.get(row.patientId);
    if (loaded) {
      loaded.issues.push(
        anomaly(
          'DUPLICATE_CONFLICT',
          loaded,
          `line ${row.line} for the same patient was quarantined and its recency could not be compared; confirm this version is current`,
        ),
      );
    }
  }

  const rowsWith = (code: AnomalyCode) => rows.filter((row) => row.issues.some((issue) => issue.code === code)).length;
  const stats: TransformStats = {
    totalRows: rows.length,
    recordsReady: records.length,
    rejectedRows: rows.filter((row) => row.status === 'rejected').length,
    repairedRows: rowsWith('ROW_REPAIRED'),
    malformedRows: rowsWith('ROW_MALFORMED'),
    duplicateRowsRemoved: rows.filter((row) => row.status === 'superseded').length,
    patientsWithDuplicates: duplicates.length,
    missingEmail: records.filter((record) => record.email === null).length,
    missingPhone: records.filter((record) => record.phone === null).length,
    datesNormalized: rowsWith('DOB_REFORMATTED'),
    ambiguousDates: rowsWith('DOB_AMBIGUOUS'),
    balancesCleaned: rowsWith('BALANCE_CLEANED'),
    foreignCurrencyBalances: rowsWith('BALANCE_FOREIGN_CURRENCY'),
    negativeBalances: rowsWith('BALANCE_NEGATIVE'),
    invalidEmails: rowsWith('INVALID_EMAIL'),
  };

  const publicRows: RowResult[] = rows.map(({ lastModifiedMs: _ms, usable: _usable, ...row }) => row);
  return {
    header: document.header,
    records,
    rows: publicRows,
    duplicates,
    anomalySummary: summarizeAnomalies(publicRows.flatMap((row) => row.issues)),
    stats,
  };
}
