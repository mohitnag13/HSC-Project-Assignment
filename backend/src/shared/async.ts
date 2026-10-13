/**
 * Resolves `true` after `ms`, or `false` as soon as `signal` aborts.
 * Never rejects, which keeps cancellation handling in callers linear.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Injectable time source so the rate limiter and pipeline can be tested deterministically. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<boolean>;
}

export const systemClock: Clock = { now: () => Date.now(), sleep };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
