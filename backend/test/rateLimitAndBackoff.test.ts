import { describe, expect, it } from 'vitest';
import { backoffDelay, parseRetryAfter } from '../src/ingest/backoff.js';
import { bisectBatch, createBatches } from '../src/ingest/batching.js';
import { peakInWindow, RateLimiter } from '../src/ingest/rateLimiter.js';
import { classifyStatus } from '../src/ingest/shcClient.js';
import { createFakeClock, makeRecords } from './helpers.js';

describe('RateLimiter', () => {
  it('never grants more than N permits in any one-second window', async () => {
    const clock = createFakeClock();
    const limiter = new RateLimiter(5, 50, clock);
    const grants: number[] = [];
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        await limiter.acquire();
        grants.push(clock.now());
      }),
    );
    expect(grants).toHaveLength(40);
    expect(peakInWindow(grants.sort((a, b) => a - b))).toBe(5);
    for (let index = 1; index < grants.length; index += 1) {
      expect((grants[index] as number) - (grants[index - 1] as number)).toBeGreaterThanOrEqual(limiter.intervalMs);
    }
  });

  it('spaces permits by ceil((1000 + margin) / N)', () => {
    expect(new RateLimiter(5, 50).intervalMs).toBe(210);
    expect(new RateLimiter(5, 0).intervalMs).toBe(200);
  });

  it('gives up without consuming a permit when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const limiter = new RateLimiter(5, 0, createFakeClock());
    expect(await limiter.acquire(controller.signal)).toBe(false);
  });
});

describe('peakInWindow', () => {
  it('counts the densest one-second window', () => {
    expect(peakInWindow([0, 100, 999, 1000, 1500, 2600])).toBe(3);
    expect(peakInWindow([])).toBe(0);
  });
});

describe('backoffDelay', () => {
  const policy = { baseMs: 500, maxMs: 30_000 };

  it('doubles per retry, with equal jitter in [d/2, d]', () => {
    expect(backoffDelay(1, policy, null, () => 0)).toBe(250);
    expect(backoffDelay(1, policy, null, () => 1)).toBe(500);
    expect(backoffDelay(2, policy, null, () => 1)).toBe(1000);
    expect(backoffDelay(4, policy, null, () => 1)).toBe(4000);
  });

  it('is capped at maxMs', () => {
    expect(backoffDelay(20, policy, null, () => 1)).toBe(30_000);
  });

  it('honours Retry-After as a floor', () => {
    expect(backoffDelay(1, policy, 2000, () => 1)).toBe(2000);
  });

  it('caps an extreme Retry-After instead of stalling for a day', () => {
    expect(backoffDelay(1, policy, 86_400_000, () => 1)).toBe(60_000);
    expect(backoffDelay(1, { baseMs: 500, maxMs: 120_000 }, 86_400_000, () => 1)).toBe(120_000);
  });
});

describe('parseRetryAfter', () => {
  it('accepts delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('Sat, 10 Oct 2026 12:00:05 GMT', Date.parse('2026-10-10T12:00:00Z'))).toBe(5000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('classifyStatus', () => {
  it.each([
    [200, 'success'],
    [201, 'success'],
    [301, 'fatal'],
    [302, 'fatal'],
    [307, 'fatal'],
    [400, 'bad_request'],
    [422, 'bad_request'],
    [401, 'fatal'],
    [403, 'fatal'],
    [404, 'fatal'],
    [408, 'retryable'],
    [429, 'retryable'],
    [500, 'retryable'],
    [503, 'retryable'],
    [409, 'rejected'],
    [413, 'rejected'],
  ])('%i -> %s', (status, outcome) => {
    expect(classifyStatus(status)).toBe(outcome);
  });
});

describe('batching', () => {
  it('splits into batches of at most the configured size', () => {
    const batches = createBatches(makeRecords(250), 100);
    expect(batches.map((batch) => batch.records.length)).toEqual([100, 100, 50]);
    expect(batches.map((batch) => batch.id)).toEqual(['B001', 'B002', 'B003']);
  });

  it('bisects into named halves', () => {
    const [left, right] = bisectBatch({ id: 'B001', records: makeRecords(5) });
    expect([left.id, left.records.length, right.id, right.records.length]).toEqual(['B001.1', 3, 'B001.2', 2]);
  });
});
