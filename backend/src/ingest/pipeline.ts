import { randomBytes } from 'node:crypto';
import type { PatientRecord } from '../domain/patient.js';
import { errorMessage, systemClock, type Clock } from '../shared/async.js';
import { backoffDelay } from './backoff.js';
import { bisectBatch, createBatches } from './batching.js';
import { FailedRecordsLog } from './failedRecords.js';
import { peakInWindow, RateLimiter } from './rateLimiter.js';
import { sendBatch, type SendResult } from './shcClient.js';
import type {
  Batch,
  FailureReason,
  IngestionConfig,
  IngestionEvent,
  IngestionEventPayload,
  IngestionSettings,
  RunStatus,
  RunSummary,
} from './types.js';

export interface RunIngestionOptions {
  runId?: string;
  onEvent?: (event: IngestionEvent) => void;
  /** Cancels the run: no new requests are started; in-flight requests complete. */
  signal?: AbortSignal;
  failedRecords?: FailedRecordsLog;
  fetchImpl?: typeof fetch;
  random?: () => number;
  clock?: Clock;
}

export function createRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  return `run_${stamp}_${randomBytes(3).toString('hex')}`;
}

/** Settings without the endpoint and secret, safe to log and to show in the UI. */
export function publicSettings(config: IngestionConfig): IngestionSettings {
  const { apiUrl: _apiUrl, apiToken: _apiToken, ...settings } = config;
  return settings;
}

/** After this many batches in a row exhaust their retries, the API is treated as down and the run stops. */
export const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Reads per-record errors from a 400 body shaped `{ errors: [{ index, ... }] }`
 * (index = position in the request's `patients` array). Returns null when the
 * body does not identify records unambiguously, so the caller falls back to
 * bisection instead of trusting a partial answer.
 */
export function invalidRecordIndices(body: unknown, batchSize: number): Map<number, unknown[]> | null {
  if (!body || typeof body !== 'object' || !('errors' in body) || !Array.isArray(body.errors)) return null;
  const byIndex = new Map<number, unknown[]>();
  for (const error of body.errors as unknown[]) {
    const index = (error as { index?: unknown } | null)?.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= batchSize) return null;
    byIndex.set(index, [...(byIndex.get(index) ?? []), error]);
  }
  return byIndex.size > 0 ? byIndex : null;
}

/**
 * Load: batches the normalised records and POSTs them to the SHC API.
 *
 * - at most `batchSize` (<= 100) records per request
 * - at most `maxRequestsPerSecond` request starts per second, retries included
 * - 408/429/5xx/network errors: exponential backoff with jitter, honouring Retry-After;
 *   after CIRCUIT_BREAKER_THRESHOLD batches in a row exhaust their retries, the run stops
 * - 400/422: the records the API names as invalid go to failed_records.json and the
 *   rest are re-sent once; if the API does not name them, the batch is bisected until
 *   the offending records are isolated. Either way the pipeline carries on.
 * - 3xx/401/403/404, or a request that cannot be built: the run stops early (bad URL or credentials)
 *
 * Never throws; every outcome is reflected in the returned summary.
 */
export async function runIngestion(
  records: readonly PatientRecord[],
  config: IngestionConfig,
  options: RunIngestionOptions = {},
): Promise<RunSummary> {
  const runId = options.runId ?? createRunId();
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const failedLog = options.failedRecords ?? new FailedRecordsLog(null);
  const { signal } = options;
  const startedAt = clock.now();
  let seq = 0;

  const emit = (payload: IngestionEventPayload) => {
    const now = clock.now();
    const event = { ...payload, seq: (seq += 1), at: new Date(now).toISOString(), elapsedMs: now - startedAt } as IngestionEvent;
    try {
      options.onEvent?.(event);
    } catch {
      // A misbehaving listener (e.g. a closed SSE socket) must not break the load.
    }
  };

  const batches = createBatches(records, config.batchSize);
  const limiter = new RateLimiter(config.maxRequestsPerSecond, config.rateLimitSafetyMs, clock);
  const counts = { loaded: 0, failed: 0, skipped: 0, requests: 0, succeeded: 0, retried: 0, isolated: 0, bisected: 0 };
  let consecutiveExhausted = 0;
  const byStatus: Record<string, number> = {};
  const failuresByReason: Record<FailureReason, number> = { bad_request: 0, retries_exhausted: 0, rejected: 0 };
  const requestStarts: number[] = [];
  let abortReason: string | null = null;
  const halted = () => abortReason !== null || signal?.aborted === true;

  const progress = () =>
    emit({
      type: 'progress',
      total: records.length,
      loaded: counts.loaded,
      failed: counts.failed,
      notAttempted: counts.skipped,
      pending: Math.max(0, records.length - counts.loaded - counts.failed - counts.skipped),
      requests: counts.requests,
    });

  const skip = (batch: Batch) => {
    counts.skipped += batch.records.length;
    progress();
  };

  const abort = (reason: string, status: number | null) => {
    if (abortReason !== null) return;
    abortReason = reason;
    emit({ type: 'run_aborting', reason, status });
  };

  /** `details[i]`, when given, is the API's error for `batch.records[i]` (instead of the whole response body). */
  const fail = async (batch: Batch, reason: FailureReason, result: SendResult, attempts: number, details?: unknown[]) => {
    const failedAt = new Date(clock.now()).toISOString();
    counts.failed += batch.records.length;
    failuresByReason[reason] += batch.records.length;
    await failedLog.add(
      batch.records.map((record, index) => ({
        run_id: runId,
        patient_id: record.patient_id,
        reason,
        status: result.status,
        message: result.message,
        error: details?.[index] ?? result.body ?? result.message,
        batch_id: batch.id,
        attempts,
        failed_at: failedAt,
        record,
      })),
    );
    emit({
      type: 'records_failed',
      batchId: batch.id,
      reason,
      status: result.status,
      patientIds: batch.records.map((record) => record.patient_id),
      message: result.message,
    });
    progress();
  };

  const deliver = async (batch: Batch): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      if (halted() || !(await limiter.acquire(signal)) || halted()) return skip(batch);

      const sentAt = clock.now();
      requestStarts.push(sentAt);
      counts.requests += 1;
      const result = await sendBatch(batch.records, {
        apiUrl: config.apiUrl,
        apiToken: config.apiToken,
        timeoutMs: config.requestTimeoutMs,
        fetchImpl: options.fetchImpl,
      });
      const statusKey = result.status === null ? 'network' : String(result.status);
      byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;
      emit({
        type: 'request_completed',
        batchId: batch.id,
        attempt,
        size: batch.records.length,
        status: result.status,
        outcome: result.outcome,
        durationMs: result.durationMs,
        sentAtMs: sentAt - startedAt,
        message: result.message,
      });

      switch (result.outcome) {
        case 'success':
          counts.succeeded += 1;
          counts.loaded += batch.records.length;
          consecutiveExhausted = 0;
          emit({ type: 'batch_succeeded', batchId: batch.id, size: batch.records.length, attempts: attempt });
          progress();
          return;

        case 'retryable': {
          if (attempt > config.maxRetries) {
            await fail(batch, 'retries_exhausted', result, attempt);
            consecutiveExhausted += 1;
            if (consecutiveExhausted >= CIRCUIT_BREAKER_THRESHOLD) {
              abort(
                `${consecutiveExhausted} batches in a row exhausted their retries (last: ${result.message}); the SHC API appears to be unavailable`,
                result.status,
              );
            }
            return;
          }
          const delayMs = backoffDelay(
            attempt,
            { baseMs: config.backoffBaseMs, maxMs: config.backoffMaxMs },
            result.retryAfterMs,
            random,
          );
          counts.retried += 1;
          emit({
            type: 'retry_scheduled',
            batchId: batch.id,
            nextAttempt: attempt + 1,
            delayMs,
            status: result.status,
            reason: result.message,
          });
          if (!(await clock.sleep(delayMs, signal))) return skip(batch);
          continue;
        }

        case 'bad_request': {
          const flagged = invalidRecordIndices(result.body, batch.records.length);
          if (flagged) {
            const invalid: PatientRecord[] = [];
            const details: unknown[] = [];
            const remaining: PatientRecord[] = [];
            batch.records.forEach((record, index) => {
              const errors = flagged.get(index);
              if (errors) {
                invalid.push(record);
                details.push({ message: result.message, errors });
              } else {
                remaining.push(record);
              }
            });
            counts.isolated += 1;
            const retryBatchId = remaining.length > 0 ? `${batch.id}.r` : null;
            emit({ type: 'records_isolated', batchId: batch.id, size: batch.records.length, invalid: invalid.length, retryBatchId });
            await fail({ id: batch.id, records: invalid }, 'bad_request', result, attempt, details);
            if (retryBatchId) await deliver({ id: retryBatchId, records: remaining });
            return;
          }
          if (config.bisectOn400 && batch.records.length > 1) {
            const [left, right] = bisectBatch(batch);
            counts.bisected += 1;
            emit({ type: 'batch_bisected', batchId: batch.id, size: batch.records.length, children: [left.id, right.id] });
            await deliver(left);
            await deliver(right);
            return;
          }
          return fail(batch, 'bad_request', result, attempt);
        }

        case 'fatal':
          abort(result.message, result.status);
          return skip(batch);

        case 'rejected':
          return fail(batch, 'rejected', result, attempt);
      }
    }
  };

  emit({
    type: 'run_started',
    runId,
    apiUrl: config.apiUrl,
    totalRecords: records.length,
    totalBatches: batches.length,
    settings: publicSettings(config),
  });

  const queue = [...batches];
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      if (halted()) {
        skip(batch);
        continue;
      }
      try {
        await deliver(batch);
      } catch (error) {
        // Only bookkeeping can throw here (e.g. failed_records.json not writable).
        // Stop rather than keep loading without a record of what failed.
        abort(`internal error: ${errorMessage(error)}`, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(config.concurrency, batches.length)) }, worker));

  try {
    await failedLog.flush();
  } catch (error) {
    abort(`could not write failed records: ${errorMessage(error)}`, null);
  }

  const finishedAt = clock.now();
  const notAttempted = records.length - counts.loaded - counts.failed;
  // A cancel that lands after the last batch was sent did not actually stop anything.
  const status: RunStatus =
    abortReason !== null
      ? 'aborted'
      : signal?.aborted && notAttempted > 0
        ? 'cancelled'
        : counts.failed > 0 || notAttempted > 0
          ? 'completed_with_failures'
          : 'succeeded';

  const summary: RunSummary = {
    runId,
    status,
    apiUrl: config.apiUrl,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    records: { total: records.length, loaded: counts.loaded, failed: counts.failed, notAttempted },
    batches: { planned: batches.length, isolated: counts.isolated, bisected: counts.bisected },
    requests: {
      total: counts.requests,
      succeeded: counts.succeeded,
      retried: counts.retried,
      byStatus,
      peakPerSecond: peakInWindow(requestStarts),
    },
    failuresByReason,
    abortReason,
    failedRecordsFile: failedLog.filePath,
  };
  emit({ type: 'run_finished', summary });
  return summary;
}
