import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { PatientRecord } from '../domain/patient.js';
import { sleep } from '../shared/async.js';
import type { MockShcStore } from './store.js';
import { validatePatient } from './validation.js';

export interface MockAppOptions {
  /** Injectable randomness for deterministic fault injection in tests. */
  random?: () => number;
}

const INJECTED_SERVER_ERRORS = [500, 502, 503] as const;

function bearerToken(request: Request): string {
  const header = request.get('authorization') ?? '';
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}

/**
 * Mock of the SHC Platform API (https://api.mock-shc.com/v1/patients) that
 * enforces the published contract: Bearer auth, at most 100 records per
 * request, at most 5 requests per second (429 + Retry-After), and record
 * validation (400 with per-record details). Optional fault injection adds
 * random 5xx errors, throttling and latency.
 */
export function createMockShcApp(store: MockShcStore, options: MockAppOptions = {}): express.Express {
  const random = options.random ?? Math.random;
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: 'mock-shc-api' });
  });

  app.post('/v1/patients', express.json({ limit: '5mb' }), async (request, response) => {
    const started = performance.now();
    const settings = store.settings;
    const now = Date.now();
    store.noteArrival(now);

    const respond = (
      status: number,
      body: unknown,
      note: string,
      records = 0,
      headers: Record<string, string> = {},
    ) => {
      response.set(headers).status(status).json(body);
      store.recordRequest({ status, records, durationMs: Math.round(performance.now() - started), note });
    };

    if (settings.requireAuth) {
      const token = bearerToken(request);
      if (!store.isAuthorized(token)) {
        return respond(
          401,
          { error: 'unauthorized', message: 'A valid Bearer token is required' },
          token ? 'invalid token' : 'missing token',
          0,
          { 'WWW-Authenticate': 'Bearer realm="shc"' },
        );
      }
    }

    if (settings.enforceRateLimit) {
      const admission = store.admit(now);
      if (!admission.allowed) {
        return respond(
          429,
          { error: 'too_many_requests', message: `Rate limit of ${settings.maxRequestsPerSecond} requests per second exceeded` },
          'rate limit exceeded',
          0,
          { 'Retry-After': String(Math.max(1, Math.ceil(admission.retryAfterMs / 1000))) },
        );
      }
    }

    const latency = settings.latencyMinMs + random() * (settings.latencyMaxMs - settings.latencyMinMs);
    await sleep(Math.round(latency));

    if (random() < settings.throttleRate) {
      return respond(429, { error: 'too_many_requests', message: 'Throttled (injected)' }, 'injected 429', 0, {
        'Retry-After': '1',
      });
    }
    if (random() < settings.failureRate) {
      const status = INJECTED_SERVER_ERRORS[Math.floor(random() * INJECTED_SERVER_ERRORS.length)] ?? 503;
      return respond(status, { error: 'server_error', message: 'Upstream failure (injected)' }, `injected ${status}`);
    }

    const patients: unknown = (request.body as { patients?: unknown } | undefined)?.patients;
    if (!Array.isArray(patients)) {
      return respond(400, { error: 'bad_request', message: 'Body must be a JSON object of the form { "patients": [ ... ] }' }, 'malformed body');
    }
    if (patients.length === 0) {
      return respond(400, { error: 'bad_request', message: 'patients must contain at least one record' }, 'empty batch');
    }
    if (patients.length > settings.maxBatchSize) {
      return respond(
        413,
        { error: 'payload_too_large', message: `A request may contain at most ${settings.maxBatchSize} records (got ${patients.length})` },
        'batch too large',
        patients.length,
      );
    }

    if (settings.validateRecords) {
      const issues = patients.flatMap((patient, index) => validatePatient(patient, index));
      if (issues.length > 0) {
        const invalid = new Set(issues.map((issue) => issue.index)).size;
        return respond(
          400,
          {
            error: 'validation_failed',
            message: `${invalid} of ${patients.length} record(s) failed validation; the batch was rejected`,
            errors: issues.slice(0, 100),
          },
          `${invalid} invalid record(s)`,
          patients.length,
        );
      }
    }

    const result = store.upsert(patients as PatientRecord[], new Date());
    return respond(
      200,
      { request_id: randomUUID(), accepted: patients.length, created: result.created, updated: result.updated, unchanged: result.stale },
      `accepted ${patients.length}`,
      patients.length,
    );
  });

  app.get('/v1/patients', (request, response) => {
    if (store.settings.requireAuth && !store.isAuthorized(bearerToken(request))) {
      response.status(401).json({ error: 'unauthorized', message: 'A valid Bearer token is required' });
      return;
    }
    const { total, items } = store.listPatients({ limit: 100 });
    response.json({ total, patients: items });
  });

  app.use((request, response) => {
    response.status(404).json({ error: 'not_found', message: `No route for ${request.method} ${request.path}` });
  });

  app.use((error: { status?: number; type?: string; message?: string }, _request: Request, response: Response, _next: NextFunction) => {
    const status = error.type === 'entity.too.large' ? 413 : error.status && error.status < 500 ? error.status : 500;
    const message = error.type === 'entity.parse.failed' ? 'Request body is not valid JSON' : (error.message ?? 'Internal error');
    store.recordRequest({ status, records: 0, durationMs: 0, note: message });
    response.status(status).json({ error: status === 500 ? 'server_error' : 'bad_request', message });
  });

  return app;
}
