import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKEND_ROOT, REPO_ROOT, SAMPLE_CSV } from '../src/config/paths.js';
import { createConsoleApp, type ConsoleAppDeps } from '../src/server/app.js';
import { RunManager } from '../src/server/runManager.js';
import { closeServer, listen } from '../src/shared/http.js';
import { silentLogger } from '../src/shared/logger.js';
import { startMockApi, tempDir, TEST_TOKEN } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const sampleCsv = readFileSync(SAMPLE_CSV, 'utf8');

async function startConsole(security: ConsoleAppDeps['security'] = { hostGuard: true, allowCustomTargets: false }) {
  const mock = await startMockApi();
  cleanups.push(mock.close);
  const app = createConsoleApp({
    runs: new RunManager({ outputDir: await tempDir(), logger: silentLogger }),
    mock: { store: mock.store, apiUrl: mock.url, token: TEST_TOKEN },
    defaultApiUrl: 'https://api.mock-shc.com/v1/patients',
    paths: { sampleCsv: SAMPLE_CSV, repoRoot: REPO_ROOT, backendRoot: BACKEND_ROOT, staticDir: null },
    security,
    logger: silentLogger,
  });
  const server = await listen(app, 0, '127.0.0.1');
  cleanups.push(() => closeServer(server));
  return { port: (server.address() as AddressInfo).port, mock };
}

/** node:http rather than fetch, because the tests need to forge the Host header. */
function call(
  port: number,
  method: string,
  path: string,
  options: { json?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const payload = options.json === undefined ? undefined : JSON.stringify(options.json);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: `localhost:${port}`,
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForRun(port: number, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { body } = await call(port, 'GET', `/api/runs/${id}`);
    if (body.status !== 'running') return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('run did not finish');
}

describe('console API', () => {
  it('only answers requests addressed to localhost (DNS-rebinding guard)', async () => {
    const { port } = await startConsole();
    expect((await call(port, 'GET', '/api/health')).status).toBe(200);
    expect((await call(port, 'GET', '/api/health', { headers: { Host: 'evil.example' } })).status).toBe(403);
  });

  it('runs a load end to end against the mock and reports it', async () => {
    const { port, mock } = await startConsole();
    const started = await call(port, 'POST', '/api/runs', { json: { csv: sampleCsv, fileName: 'patients.csv', target: { kind: 'mock' } } });
    expect(started.status).toBe(202);
    const finished = await waitForRun(port, started.body.id);
    expect(finished).toMatchObject({ status: 'succeeded', summary: { records: { loaded: 7, total: 7 } } });
    expect(mock.store.patientCount).toBe(7);
  });

  it('lets an empty mock token demonstrate the 401 abort', async () => {
    const { port } = await startConsole();
    const started = await call(port, 'POST', '/api/runs', { json: { csv: sampleCsv, target: { kind: 'mock', apiToken: '' } } });
    const finished = await waitForRun(port, started.body.id);
    expect(finished.status).toBe('aborted');
    expect(finished.summary.abortReason).toContain('401');
  });

  it('refuses custom targets unless they are enabled', async () => {
    const { port } = await startConsole();
    const target = { kind: 'custom', apiUrl: 'http://127.0.0.1:9/internal', apiToken: 't' };
    const response = await call(port, 'POST', '/api/runs', { json: { csv: sampleCsv, target } });
    expect(response.status).toBe(403);
    expect((await call(port, 'GET', '/api/config')).body.customTargetsAllowed).toBe(false);
  });

  it('rejects custom target URLs that carry credentials', async () => {
    const { port } = await startConsole({ hostGuard: true, allowCustomTargets: true });
    const target = { kind: 'custom', apiUrl: 'https://user:secret@api.example.com/v1/patients', apiToken: 't' };
    const response = await call(port, 'POST', '/api/runs', { json: { csv: sampleCsv, target } });
    expect(response).toMatchObject({ status: 400, body: { message: expect.stringContaining('credentials') } });
  });

  it('keeps the status of client errors raised by middleware', async () => {
    const { port } = await startConsole();
    const response = await call(port, 'POST', '/api/transform', {
      json: { csv: sampleCsv },
      // The JSON parser only accepts utf-* charsets and answers anything else with 415.
      headers: { 'Content-Type': 'application/json; charset=iso-8859-1' },
    });
    expect(response.status).toBe(415);
  });
});
