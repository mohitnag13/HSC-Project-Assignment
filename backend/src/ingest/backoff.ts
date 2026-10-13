export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/** A server's Retry-After is honoured up to this much, or BACKOFF_MAX_MS if that is larger. */
export const RETRY_AFTER_CEILING_MS = 60_000;

/**
 * Exponential backoff with "equal jitter": the delay for retry n is drawn
 * from [d/2, d] where d = min(maxMs, baseMs * 2^(n-1)). Half of the delay is
 * guaranteed (so a struggling API really gets breathing room) and half is
 * random (so concurrent workers do not retry in lock-step). A server-provided
 * Retry-After is treated as a floor, capped so that "retry in 24 h" cannot
 * stall a batch indefinitely.
 */
export function backoffDelay(
  retryNumber: number,
  policy: BackoffPolicy,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, retryNumber - 1));
  const jittered = exponential / 2 + random() * (exponential / 2);
  const serverFloor = Math.min(retryAfterMs ?? 0, Math.max(policy.maxMs, RETRY_AFTER_CEILING_MS));
  return Math.round(Math.max(jittered, serverFloor));
}

/** Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
