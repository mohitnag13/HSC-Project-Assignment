import { afterEach, describe, expect, it } from 'vitest';
import { makeRecords, startMockApi, TEST_TOKEN } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function mockApi(...args: Parameters<typeof startMockApi>) {
  const api = await startMockApi(...args);
  cleanups.push(api.close);
  return api;
}

const post = (url: string, body: unknown, token: string | null = TEST_TOKEN) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe('mock SHC API contract', () => {
  it('requires a valid Bearer token', async () => {
    const api = await mockApi();
    expect((await post(api.url, { patients: makeRecords(1) }, null)).status).toBe(401);
    expect((await post(api.url, { patients: makeRecords(1) }, 'wrong')).status).toBe(401);
    expect((await post(api.url, { patients: makeRecords(1) })).status).toBe(200);
  });

  it('rejects batches larger than 100 records', async () => {
    const api = await mockApi();
    const response = await post(api.url, { patients: makeRecords(101) });
    expect(response.status).toBe(413);
  });

  it('throttles beyond 5 requests per second with Retry-After', async () => {
    const api = await mockApi();
    const statuses = await Promise.all(Array.from({ length: 7 }, () => post(api.url, { patients: makeRecords(1) }).then((r) => r)));
    const throttled = statuses.filter((response) => response.status === 429);
    expect(statuses.filter((response) => response.status === 200)).toHaveLength(5);
    expect(throttled).toHaveLength(2);
    expect(throttled[0]?.headers.get('retry-after')).toBe('1');
  });

  it('rejects the whole batch with per-record details when any record is invalid', async () => {
    const api = await mockApi();
    const patients = makeRecords(3, (index) => (index === 1 ? { email: 'bad@', dob: '1990-02-30' } : {}));
    const response = await post(api.url, { patients });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: Array<{ index: number; field: string }> };
    expect(body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 1, field: 'email' }), expect.objectContaining({ index: 1, field: 'dob' })]),
    );
    expect(api.store.patientCount).toBe(0);
  });

  it('upserts by patient_id and ignores stale versions', async () => {
    const api = await mockApi();
    await post(api.url, { patients: makeRecords(1, () => ({ email: 'new@x.com', last_modified: '2026-10-05T00:00:00.000Z' })) });
    const response = await post(api.url, { patients: makeRecords(1, () => ({ email: 'old@x.com', last_modified: '2026-09-01T00:00:00.000Z' })) });
    expect(await response.json()).toMatchObject({ accepted: 1, created: 0, updated: 0, unchanged: 1 });
    expect(api.store.listPatients().items[0]?.email).toBe('new@x.com');
  });

  it('can inject server errors for fault-tolerance testing', async () => {
    const api = await mockApi({ failureRate: 1 });
    const response = await post(api.url, { patients: makeRecords(1) });
    expect([500, 502, 503]).toContain(response.status);
  });
});
