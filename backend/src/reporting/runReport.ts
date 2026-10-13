import type { PatientColumn } from '../domain/patient.js';
import type { Severity } from '../etl/anomalies.js';
import type { DuplicateGroup, TransformResult, TransformStats } from '../etl/transform.js';
import type { RunSummary } from '../ingest/types.js';

export interface RunReport {
  generated_at: string;
  source: { file: string; rows: number };
  transform: {
    stats: TransformStats;
    anomalies: Array<{ code: string; severity: Severity; title: string; count: number }>;
    rejected_rows: Array<{ line: number; patient_id: string | null; errors: string[] }>;
    duplicates: Array<{
      patient_id: string;
      kept_line: number | null;
      superseded_lines: number[];
      resolution: DuplicateGroup['resolution'];
      changed_fields: PatientColumn[];
      notes: string[];
    }>;
  };
  ingestion: RunSummary | null;
}

/**
 * run_report.json: everything an operator needs to audit a run. It references
 * rows by line number, patient_id, anomaly code and field name only; anomaly
 * messages quote field values (PHI) and are deliberately left out.
 */
export function buildRunReport(input: {
  sourceFile: string;
  transform: TransformResult;
  summary: RunSummary | null;
  now?: Date;
}): RunReport {
  const { transform } = input;
  return {
    generated_at: (input.now ?? new Date()).toISOString(),
    source: { file: input.sourceFile, rows: transform.stats.totalRows },
    transform: {
      stats: transform.stats,
      anomalies: transform.anomalySummary.map(({ code, severity, title, count }) => ({ code, severity, title, count })),
      rejected_rows: transform.rows
        .filter((row) => row.status === 'rejected')
        .map((row) => ({
          line: row.line,
          patient_id: row.patientId,
          errors: row.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => (issue.field ? `${issue.code} (${issue.field})` : issue.code)),
        })),
      duplicates: transform.duplicates.map((group) => ({
        patient_id: group.patientId,
        kept_line: group.keptLine,
        superseded_lines: group.versions.filter((version) => version.status === 'superseded').map((version) => version.line),
        resolution: group.resolution,
        changed_fields: group.changedFields,
        notes: group.notes,
      })),
    },
    ingestion: input.summary,
  };
}
