import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FailedRecordsLog } from '../src/ingest/failedRecords.js';
import { runIngestion } from '../src/ingest/pipeline.js';
import type { FailedRecordEntry, IngestionEvent } from '../src/ingest/types.js';
import { makeRecords, scriptedFetch, startMockApi, tempDir, testConfig } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function mockApi(...args: Parameters<typeof startMockApi>) {
  const api = await startMockApi(...args);
  cleanups.push(api.close);
  return api;
}

describe('runIngestion against the mock SHC API', () => {
  it('loads everything in batches of at most 100 records', async () => {
    const api = await mockApi();
    const summary = await runIngestion(makeRecords(250), testConfig(api.url));
    expect(summary).toMatchObject({ status: 'succeeded', records: { total: 250, loaded: 250, failed: 0 }, batches: { planned: 3 } });
    expect(api.store.patientCount).toBe(250);
    expect(api.store.snapshot().recentRequests.map((request) => request.records).sort()).toEqual([100, 100, 50]);
  });

  it('respects 5 requests per second as observed by the API itself', async () => {
    const api = await mockApi();
    const summary = await runIngestion(
      makeRecords(120),
      testConfig(api.url, { batchSize: 10, maxRequestsPerSecond: 5, rateLimitSafetyMs: 50, concurrency: 4 }),
    );
    expect(summary.status).toBe('succeeded');
    expect(summary.requests.total).toBe(12);
    expect(summary.requests.byStatus['429']).toBeUndefined();
    expect(summary.requests.peakPerSecond).toBeLessThanOrEqual(5);
    expect(api.store.snapshot().stats.peakArrivalsPerSecond).toBeLessThanOrEqual(5);
  });

  it('recovers from 429 / 5xx / network errors with exponential backoff', async () => {
    const api = await mockApi();
    const fetchImpl = scriptedFetch([503, 429, 'network', 500]);
    const events: IngestionEvent[] = [];
    const summary = await runIngestion(makeRecords(10), testConfig(api.url), { fetchImpl, onEvent: (event) => events.push(event) });

    expect(summary).toMatchObject({ status: 'succeeded', records: { loaded: 10 } });
    expect(summary.requests).toMatchObject({ total: 5, retried: 4, byStatus: { '503': 1, '429': 1, network: 1, '500': 1, '200': 1 } });
    const retries = events.filter((event) => event.type === 'retry_scheduled');
    expect(retries.map((event) => event.nextAttempt)).toEqual([2, 3, 4, 5]);
  });

  it('honours Retry-After when the API throttles', async () => {
    const api = await mockApi();
    const fetchImpl = scriptedFetch([429], { 'Retry-After': '1' });
    const delays: number[] = [];
    await runIngestion(makeRecords(1), testConfig(api.url), {
      fetchImpl,
      onEvent: (event) => {
        if (event.type === 'retry_scheduled') delays.push(event.delayMs);
      },
    });
    expect(delays).toEqual([1000]);
  });

  it('records batches as retries_exhausted once retries are used up, without halting', async () => {
    const api = await mockApi();
    const fetchImpl = scriptedFetch([503, 503, 503]);
    const summary = await runIngestion(makeRecords(20), testConfig(api.url, { batchSize: 10, maxRetries: 2, concurrency: 1 }), { fetchImpl });
    expect(summary).toMatchObject({
      status: 'completed_with_failures',
      records: { loaded: 10, failed: 10 },
      failuresByReason: { retries_exhausted: 10 },
    });
  });

  it('uses the per-record errors of a 400 to fail only the named records, then re-sends the rest once', async () => {
    const api = await mockApi();
    const dir = await tempDir();
    const file = join(dir, 'failed_records.json');
    const records = makeRecords(20, (index) => (index === 3 || index === 14 ? { email: `broken${index}@` } : {}));

    const summary = await runIngestion(records, testConfig(api.url), { failedRecords: new FailedRecordsLog(file) });

    expect(summary).toMatchObject({
      status: 'completed_with_failures',
      records: { loaded: 18, failed: 2 },
      batches: { isolated: 1, bisected: 0 },
      requests: { total: 2 },
    });
    expect(api.store.patientCount).toBe(18);

    const written = JSON.parse(await readFile(file, 'utf8')) as FailedRecordEntry[];
    expect(written.map((entry) => entry.patient_id).sort()).toEqual(['P-1003', 'P-1014']);
    expect(written[0]).toMatchObject({ reason: 'bad_request', status: 400, record: { email: expect.stringContaining('@') } });
    // Each entry carries the API's error for that record only.
    expect(written[0]?.error).toMatchObject({ errors: [expect.objectContaining({ field: 'email', index: expect.any(Number) })] });
  });

  it('falls back to bisection when a 400 does not say which records are invalid', async () => {
    const api = await mockApi();
    const records = makeRecords(20, (index) => (index === 3 || index === 14 ? { email: `broken${index}@` } : {}));
    const vague400: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      return response.status === 400 ? new Response(JSON.stringify({ message: 'invalid batch' }), { status: 400 }) : response;
    };

    const summary = await runIngestion(records, testConfig(api.url), { fetchImpl: vague400 });

    expect(summary).toMatchObject({ records: { loaded: 18, failed: 2 }, batches: { isolated: 0 } });
    expect(summary.batches.bisected).toBeGreaterThan(0);
    expect(api.store.patientCount).toBe(18);
  });

  it('logs the whole batch when bisection is disabled and the 400 names no records', async () => {
    const api = await mockApi();
    const summary = await runIngestion(makeRecords(10), testConfig(api.url, { bisectOn400: false }), {
      fetchImpl: scriptedFetch([400]),
    });
    expect(summary.records).toMatchObject({ loaded: 0, failed: 10 });
    expect(summary.requests.total).toBe(1);
  });

  it('treats a redirect as a misconfiguration instead of a successful load', async () => {
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method === 'POST') posts += 1;
      // A GET to the redirect target would succeed: following the redirect must not count as a load.
      if (request.method === 'POST') response.writeHead(301, { Location: '/elsewhere' }).end();
      else response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;

    const summary = await runIngestion(makeRecords(250), testConfig(`http://127.0.0.1:${port}/v1/patients`, { concurrency: 1 }));

    expect(summary).toMatchObject({ status: 'aborted', records: { loaded: 0, notAttempted: 250 } });
    expect(summary.abortReason).toContain('redirected to /elsewhere');
    expect(posts).toBe(1);
  });

  it('stops at once when the request cannot even be built, instead of retrying it as a network error', async () => {
    const api = await mockApi();
    const summary = await runIngestion(makeRecords(30), testConfig(api.url, { apiToken: 'tökén-€', batchSize: 10, concurrency: 1 }));
    expect(summary).toMatchObject({ status: 'aborted', records: { loaded: 0, notAttempted: 30 }, requests: { total: 1, retried: 0 } });
    expect(summary.abortReason).toContain('could not be built');
  });

  it('opens the circuit after several batches in a row exhaust their retries', async () => {
    const unreachable: typeof fetch = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    };
    const summary = await runIngestion(makeRecords(60), testConfig('http://127.0.0.1:9/v1/patients', { batchSize: 10, maxRetries: 0, concurrency: 1 }), {
      fetchImpl: unreachable,
    });
    expect(summary).toMatchObject({
      status: 'aborted',
      records: { loaded: 0, failed: 30, notAttempted: 30 },
      failuresByReason: { retries_exhausted: 30 },
    });
    expect(summary.abortReason).toContain('appears to be unavailable');
  });

  it('reports success, not "cancelled", when the cancel arrives after everything was sent', async () => {
    const api = await mockApi();
    const controller = new AbortController();
    const summary = await runIngestion(makeRecords(10), testConfig(api.url), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'batch_succeeded') controller.abort();
      },
    });
    expect(summary).toMatchObject({ status: 'succeeded', records: { loaded: 10, notAttempted: 0 } });
  });

  it('aborts early on 401 instead of retrying every batch', async () => {
    const api = await mockApi();
    const dir = await tempDir();
    const file = join(dir, 'failed_records.json');
    const summary = await runIngestion(makeRecords(300), testConfig(api.url, { apiToken: 'wrong', concurrency: 1 }), {
      failedRecords: new FailedRecordsLog(file),
    });
    expect(summary).toMatchObject({ status: 'aborted', records: { loaded: 0, failed: 0, notAttempted: 300 } });
    expect(summary.abortReason).toContain('401');
    expect(summary.requests.total).toBe(1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
  });

  it('stops sending when cancelled and reports what was not attempted', async () => {
    const api = await mockApi();
    const controller = new AbortController();
    const summary = await runIngestion(makeRecords(100), testConfig(api.url, { batchSize: 10, maxRequestsPerSecond: 2, concurrency: 1 }), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'batch_succeeded') controller.abort();
      },
    });
    expect(summary.status).toBe('cancelled');
    expect(summary.records.loaded).toBe(10);
    expect(summary.records.notAttempted).toBe(90);
  });

  it('journals failures as they happen and writes failed_records.json once at the end', async () => {
    const dir = await tempDir();
    const file = join(dir, 'failed_records.json');
    const log = new FailedRecordsLog(file);
    const entry = (patientId: string) =>
      ({ run_id: 'r', patient_id: patientId, reason: 'bad_request', status: 400, message: 'm', error: null, batch_id: 'B001', attempts: 1, failed_at: 't', record: makeRecords(1)[0] }) as FailedRecordEntry;

    await log.add([entry('P-1'), entry('P-2')]);
    await log.add([entry('P-3')]);
    const journal = (await readFile(`${file}.partial.ndjson`, 'utf8')).trim().split('\n');
    expect(journal.map((line) => (JSON.parse(line) as FailedRecordEntry).patient_id)).toEqual(['P-1', 'P-2', 'P-3']);

    await log.flush();
    expect((JSON.parse(await readFile(file, 'utf8')) as FailedRecordEntry[]).map((item) => item.patient_id)).toEqual(['P-1', 'P-2', 'P-3']);
    await expect(access(`${file}.partial.ndjson`)).rejects.toThrow();
  });

  it('emits a coherent event stream', async () => {
    const api = await mockApi();
    const events: IngestionEvent[] = [];
    await runIngestion(makeRecords(150), testConfig(api.url), { onEvent: (event) => events.push(event) });
    expect(events[0]?.type).toBe('run_started');
    expect(events.at(-1)?.type).toBe('run_finished');
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    const lastProgress = events.filter((event) => event.type === 'progress').at(-1);
    expect(lastProgress).toMatchObject({ loaded: 150, pending: 0 });
  });
});
