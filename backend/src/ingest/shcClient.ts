import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { PatientRecord } from '../domain/patient.js';
import { parseRetryAfter } from './backoff.js';
import type { RequestOutcome } from './types.js';

export const USER_AGENT = 'shc-ingest/1.0';

export interface ShcClientOptions {
  apiUrl: string;
  apiToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch | undefined;
}

export interface SendResult {
  outcome: RequestOutcome;
  /** HTTP status, or null when no response was received (network error, timeout). */
  status: number | null;
  durationMs: number;
  retryAfterMs: number | null;
  body: unknown;
  message: string;
}

/**
 * Request envelope for POST /v1/patients. The SHC contract only fixes the
 * endpoint, auth and limits, so the envelope is isolated here: adapting to the
 * final schema is a one-line change.
 */
export function buildPayload(records: readonly PatientRecord[]): { patients: readonly PatientRecord[] } {
  return { patients: records };
}

/**
 * - 2xx: success
 * - 408, 429, 5xx: transient; retried with exponential backoff
 * - 400, 422: the payload was refused; the offending records go to failed_records.json
 * - 3xx, 401, 403, 404: configuration problem (URL, credentials); every further
 *   request would fail the same way, so the run stops instead of hammering the API.
 *   Redirects are never followed: fetch would turn the POST into a GET, and a 200
 *   for that GET would look like a successful load.
 * - other 4xx: not retryable; logged to failed_records.json
 */
export function classifyStatus(status: number): RequestOutcome {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'fatal';
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 401 || status === 403 || status === 404) return 'fatal';
  return 'rejected';
}

function describeResponse(response: Response, body: unknown): string {
  const { status } = response;
  const label = `${status} ${STATUS_CODES[status] ?? ''}`.trim();
  if (status >= 300 && status < 400) {
    return `${label}: the API redirected to ${response.headers.get('location') ?? 'another URL'}; set SHC_API_URL to the final endpoint`;
  }
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
    return `${label}: ${body.message}`;
  }
  return label;
}

/**
 * Network failures (fetch's TypeError carries the socket error as `cause`) are
 * transient. A TypeError without a cause means the request itself could not be
 * built, e.g. a token with non-ASCII characters; retrying cannot fix that.
 */
function classifyTransportError(error: unknown): { outcome: RequestOutcome; message: string } {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return { outcome: 'retryable', message: 'request timed out' };
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    if (error instanceof TypeError && cause === undefined) {
      return { outcome: 'fatal', message: `the request could not be built: ${error.message}` };
    }
    if (cause?.code) return { outcome: 'retryable', message: `network error: ${cause.code}` };
    return { outcome: 'retryable', message: `network error: ${cause?.message ?? error.message}` };
  }
  return { outcome: 'retryable', message: 'network error' };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
  }
}

/** Sends one batch. Never throws: every outcome, including transport failures, is classified. */
export async function sendBatch(records: readonly PatientRecord[], options: ShcClientOptions): Promise<SendResult> {
  const body = JSON.stringify(buildPayload(records));
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const response = await (options.fetchImpl ?? fetch)(options.apiUrl, {
      method: 'POST',
      headers: {
        ...(options.apiToken ? { Authorization: `Bearer ${options.apiToken}` } : {}),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Same payload => same key, so a retry after a lost response cannot double-apply.
        'Idempotency-Key': createHash('sha256').update(body).digest('hex'),
        'User-Agent': USER_AGENT,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const responseBody = await readBody(response);
    return {
      outcome: classifyStatus(response.status),
      status: response.status,
      durationMs: elapsed(),
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      body: responseBody,
      message: describeResponse(response, responseBody),
    };
  } catch (error) {
    const { outcome, message } = classifyTransportError(error);
    return { outcome, status: null, durationMs: elapsed(), retryAfterMs: null, body: null, message };
  }
}
