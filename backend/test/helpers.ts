import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PatientRecord } from '../src/domain/patient.js';
import { DEFAULT_INGESTION_SETTINGS } from '../src/ingest/settings.js';
import type { IngestionConfig } from '../src/ingest/types.js';
import { createMockShcApp } from '../src/mock-api/app.js';
import { MockShcStore, type MockApiSettings } from '../src/mock-api/store.js';
import type { Clock } from '../src/shared/async.js';
import { closeServer, listen, serverUrl } from '../src/shared/http.js';

export const TEST_TOKEN = 'test-token';

export function makeRecords(count: number, override: (index: number) => Partial<PatientRecord> = () => ({})): PatientRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    patient_id: `P-${1000 + index}`,
    first_name: 'Test',
    last_name: `Patient${index}`,
    dob: '1980-01-01',
    email: `patient${index}@example.com`,
    phone: '555-0100',
    account_balance: 10.5,
    last_modified: '2026-10-01T10:00:00.000Z',
    ...override(index),
  }));
}

/** Fast settings for tests that are not about timing. */
export function testConfig(apiUrl: string, overrides: Partial<IngestionConfig> = {}): IngestionConfig {
  return {
    ...DEFAULT_INGESTION_SETTINGS,
    apiUrl,
    apiToken: TEST_TOKEN,
    maxRequestsPerSecond: 50,
    rateLimitSafetyMs: 0,
    backoffBaseMs: 1,
    backoffMaxMs: 5,
    ...overrides,
  };
}

export async function startMockApi(settings: Partial<MockApiSettings> = {}) {
  const store = new MockShcStore({ tokens: [TEST_TOKEN], settings: { latencyMinMs: 0, latencyMaxMs: 0, ...settings } });
  const server = await listen(createMockShcApp(store), 0, '127.0.0.1');
  return {
    store,
    url: `${serverUrl(server, '127.0.0.1')}/v1/patients`,
    close: () => closeServer(server),
  };
}

/** Clock whose sleep advances time instantly, so timing logic is tested deterministically. */
export function createFakeClock(start = 1_000_000): Clock & { readonly sleeps: number[] } {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) return false;
      sleeps.push(ms);
      now += ms;
      return true;
    },
  };
}

/**
 * fetch wrapper that answers the first calls from a script (HTTP status or a
 * network failure) and forwards the rest to the real server.
 */
export function scriptedFetch(script: Array<number | 'network'>, headers: Record<string, string> = {}): typeof fetch & { calls: number } {
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const step = script[wrapped.calls];
    wrapped.calls += 1;
    if (step === 'network') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    if (step !== undefined) {
      return new Response(JSON.stringify({ message: `scripted ${step}` }), { status: step, headers });
    }
    return fetch(input, init);
  }) as typeof fetch & { calls: number };
  wrapped.calls = 0;
  return wrapped;
}

export const tempDir = () => mkdtemp(join(tmpdir(), 'shc-ingest-test-'));
