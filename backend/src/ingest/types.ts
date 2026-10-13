import type { PatientRecord } from '../domain/patient.js';

/** Tunables of a load run. Everything except the endpoint and token has a safe default. */
export interface IngestionSettings {
  /** Records per request; the SHC API accepts at most 100. */
  batchSize: number;
  /** Client-side request rate cap; the SHC API allows 5 req/s. */
  maxRequestsPerSecond: number;
  /** Extra spacing per one-second window to absorb network jitter. */
  rateLimitSafetyMs: number;
  /** Retries per batch for 408/429/5xx/network errors (attempts = retries + 1). */
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  requestTimeoutMs: number;
  /** Batches in flight at once. The rate limiter still caps request starts. */
  concurrency: number;
  /** On a 400, split the batch to isolate the offending records instead of failing all of them. */
  bisectOn400: boolean;
}

export interface IngestionConfig extends IngestionSettings {
  apiUrl: string;
  apiToken: string;
}

export interface Batch {
  id: string;
  records: PatientRecord[];
}

/** How a single HTTP attempt is classified. */
export type RequestOutcome = 'success' | 'retryable' | 'bad_request' | 'fatal' | 'rejected';

export type FailureReason = 'bad_request' | 'retries_exhausted' | 'rejected';

/** One entry of failed_records.json. */
export interface FailedRecordEntry {
  run_id: string;
  patient_id: string;
  reason: FailureReason;
  status: number | null;
  message: string;
  /** Response body returned by the API (or the transport error). */
  error: unknown;
  batch_id: string;
  attempts: number;
  failed_at: string;
  record: PatientRecord;
}

export type RunStatus = 'succeeded' | 'completed_with_failures' | 'aborted' | 'cancelled';

export interface RunSummary {
  runId: string;
  status: RunStatus;
  apiUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  records: { total: number; loaded: number; failed: number; notAttempted: number };
  /** isolated: 400s resolved from the API's per-record errors; bisected: 400s resolved by splitting. */
  batches: { planned: number; isolated: number; bisected: number };
  requests: {
    total: number;
    succeeded: number;
    retried: number;
    /** Keyed by HTTP status, or "network" for transport failures. */
    byStatus: Record<string, number>;
    /** Highest number of request starts observed in any one-second window. */
    peakPerSecond: number;
  };
  failuresByReason: Record<FailureReason, number>;
  abortReason: string | null;
  failedRecordsFile: string | null;
}

export type IngestionEventPayload =
  | {
      type: 'run_started';
      runId: string;
      apiUrl: string;
      totalRecords: number;
      totalBatches: number;
      settings: IngestionSettings;
    }
  | {
      type: 'request_completed';
      batchId: string;
      attempt: number;
      size: number;
      status: number | null;
      outcome: RequestOutcome;
      durationMs: number;
      /** Milliseconds since the run started at which the request was sent. */
      sentAtMs: number;
      message: string;
    }
  | { type: 'retry_scheduled'; batchId: string; nextAttempt: number; delayMs: number; status: number | null; reason: string }
  | {
      type: 'records_isolated';
      batchId: string;
      size: number;
      /** Records the API named as invalid in its 400 response. */
      invalid: number;
      /** Batch that re-sends the remaining records, if any. */
      retryBatchId: string | null;
    }
  | { type: 'batch_bisected'; batchId: string; size: number; children: [string, string] }
  | { type: 'batch_succeeded'; batchId: string; size: number; attempts: number }
  | {
      type: 'records_failed';
      batchId: string;
      reason: FailureReason;
      status: number | null;
      patientIds: string[];
      message: string;
    }
  | { type: 'run_aborting'; reason: string; status: number | null }
  | { type: 'progress'; total: number; loaded: number; failed: number; notAttempted: number; pending: number; requests: number }
  | { type: 'run_finished'; summary: RunSummary };

export type IngestionEvent = IngestionEventPayload & {
  seq: number;
  at: string;
  elapsedMs: number;
};
