import { systemClock, type Clock } from '../shared/async.js';

/**
 * Client-side rate limiter for the SHC API (max N requests per second).
 *
 * Permits are granted strictly one after another and at least
 * `ceil((1000 + safetyMarginMs) / N)` ms apart, measured from the moment the
 * previous permit was actually granted. Because N consecutive gaps always add
 * up to more than 1000 ms, no one-second window (sliding or fixed) can ever
 * contain more than N request starts, regardless of how the server counts.
 * Retries go through the same limiter, so backoff can never burst past the
 * limit either.
 */
export class RateLimiter {
  readonly intervalMs: number;
  private lastGrantAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly clock: Clock;

  constructor(maxPerSecond: number, safetyMarginMs = 0, clock: Clock = systemClock) {
    if (!(maxPerSecond > 0)) throw new RangeError('maxPerSecond must be greater than 0');
    this.intervalMs = Math.ceil((1000 + safetyMarginMs) / maxPerSecond);
    this.clock = clock;
  }

  /** Waits for the next permit. Resolves false (without consuming one) if `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<boolean> {
    const turn = this.queue.then(async () => {
      const wait = this.lastGrantAt + this.intervalMs - this.clock.now();
      if (wait > 0 && !(await this.clock.sleep(wait, signal))) return false;
      if (signal?.aborted) return false;
      this.lastGrantAt = this.clock.now();
      return true;
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }
}

/** Highest number of timestamps falling inside any window of `windowMs`. */
export function peakInWindow(sortedTimestamps: readonly number[], windowMs = 1000): number {
  let peak = 0;
  let start = 0;
  for (let end = 0; end < sortedTimestamps.length; end += 1) {
    const current = sortedTimestamps[end] as number;
    while ((sortedTimestamps[start] as number) <= current - windowMs) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}
