import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { describeUrlProblem, ENV_VARS, isValidToken } from '../config/env.js';
import { CsvFormatError } from '../etl/csvReader.js';
import { transformCsv } from '../etl/transform.js';
import { DEFAULT_INGESTION_SETTINGS, INGESTION_LIMITS, resolveIngestionSettings } from '../ingest/settings.js';
import type { IngestionEvent } from '../ingest/types.js';
import type { MockShcStore } from '../mock-api/store.js';
import { errorMessage } from '../shared/async.js';
import type { Logger } from '../shared/logger.js';
import { generateDataset, MAX_GENERATED_PATIENTS } from '../tools/generateDataset.js';
import type { RunManager } from './runManager.js';

export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface ConsoleAppDeps {
  runs: RunManager;
  mock: { store: MockShcStore; apiUrl: string; token: string } | null;
  defaultApiUrl: string;
  paths: { sampleCsv: string; repoRoot: string; backendRoot: string; staticDir: string | null };
  /**
   * The console has no login, so it defends itself instead: hostGuard rejects
   * requests whose Host header is not localhost (blocks DNS rebinding from a
   * malicious web page), and allowCustomTargets decides whether runs may send
   * data to arbitrary URLs (SSRF) rather than only the bundled mock.
   */
  security: { hostGuard: boolean; allowCustomTargets: boolean };
  logger: Logger;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Server-sent-event heartbeat interval; the UI treats a few missed pings as a dead stream. */
const HEARTBEAT_MS = 10_000;

interface Deliverable {
  id: string;
  title: string;
  kind: 'markdown' | 'code';
  language: string;
  file: string;
}

function deliverables(paths: ConsoleAppDeps['paths']): Deliverable[] {
  return [
    { id: 'client-email', title: 'client_communication.md', kind: 'markdown', language: 'markdown', file: join(paths.repoRoot, 'client_communication.md') },
    { id: 'readme', title: 'README.md', kind: 'markdown', language: 'markdown', file: join(paths.repoRoot, 'README.md') },
    { id: 'dockerfile', title: 'backend/Dockerfile', kind: 'code', language: 'dockerfile', file: join(paths.backendRoot, 'Dockerfile') },
    { id: 'compose', title: 'docker-compose.yml', kind: 'code', language: 'yaml', file: join(paths.repoRoot, 'docker-compose.yml') },
    { id: 'env', title: 'backend/.env.example', kind: 'code', language: 'bash', file: join(paths.backendRoot, '.env.example') },
  ];
}

function requireCsv(body: unknown): string {
  const csv = (body as { csv?: unknown } | undefined)?.csv;
  if (typeof csv !== 'string' || !csv.trim()) throw new HttpError(400, 'Request body must include the CSV content as "csv".');
  return csv;
}

function fileNameOf(body: unknown, fallback: string): string {
  const name = (body as { fileName?: unknown } | undefined)?.fileName;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : fallback;
}

/** Mock targets: a string token is used as given (an empty one demonstrates the 401 abort); undefined means the mock's own token. */
type Target = { kind: 'mock'; apiToken: string | undefined } | { kind: 'custom'; apiUrl: string; apiToken: string };

function parseTarget(value: unknown, allowCustomTargets: boolean): Target {
  const target = (value ?? { kind: 'mock' }) as { kind?: unknown; apiUrl?: unknown; apiToken?: unknown };
  const token = typeof target.apiToken === 'string' ? target.apiToken.trim() : undefined;
  if (token && !isValidToken(token)) throw new HttpError(400, 'target.apiToken must be printable ASCII without spaces');
  if (target.kind === 'mock' || target.kind === undefined) return { kind: 'mock', apiToken: token };
  if (target.kind !== 'custom') throw new HttpError(400, 'target.kind must be "mock" or "custom"');
  if (!allowCustomTargets) {
    throw new HttpError(403, 'Custom targets are disabled on this console (ALLOW_CUSTOM_TARGETS=false); use the mock SHC API.');
  }
  if (typeof target.apiUrl !== 'string') throw new HttpError(400, 'target.apiUrl is required for a custom target');
  const problem = describeUrlProblem(target.apiUrl);
  if (problem) throw new HttpError(400, `target.apiUrl ${problem}`);
  if (!token) throw new HttpError(400, 'target.apiToken is required for a custom target');
  return { kind: 'custom', apiUrl: new URL(target.apiUrl).toString(), apiToken: token };
}

function streamRunEvents(deps: ConsoleAppDeps, request: Request, response: Response) {
  const run = deps.runs.get(String(request.params.id));
  if (!run) throw new HttpError(404, 'Run not found');

  response.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();

  // EventSource sends Last-Event-ID when it reconnects; replay only what was missed.
  const lastSeen = Number(request.get('last-event-id') ?? request.query.after ?? 0) || 0;
  const send = (event: IngestionEvent) => response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  const end = () => {
    response.write('event: end\ndata: {}\n\n');
    response.end();
  };

  for (const event of run.events) if (event.seq > lastSeen) send(event);
  if (run.events.at(-1)?.type === 'run_finished') {
    end();
    return;
  }

  // A named event, not an SSE comment: browsers never surface comments to scripts, and the
  // client uses the pings to notice a stream a proxy kept half-open after the backend died.
  const heartbeat = setInterval(() => response.write('event: ping\ndata: {}\n\n'), HEARTBEAT_MS);
  const unsubscribe = deps.runs.subscribe(run.id, (event) => {
    send(event);
    if (event.type === 'run_finished') {
      cleanup();
      end();
    }
  });
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on('close', cleanup);
}

/** Control-plane API used by the migration console UI. */
export function createConsoleApp(deps: ConsoleAppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.security.hostGuard) {
    app.use((request, response, next) => {
      if (LOCAL_HOSTNAMES.has(request.hostname)) return next();
      response.status(403).json({ error: 'forbidden_host', message: 'This console only answers requests addressed to localhost.' });
    });
  }
  const api = express.Router();
  api.use(express.json({ limit: '30mb' }));

  api.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      mockApi: deps.mock ? { apiUrl: deps.mock.apiUrl } : null,
      activeRunId: deps.runs.activeRun()?.id ?? null,
    });
  });

  api.get('/config', (_request, response) => {
    response.json({
      ingestion: { defaults: DEFAULT_INGESTION_SETTINGS, limits: INGESTION_LIMITS },
      defaultApiUrl: deps.defaultApiUrl,
      customTargetsAllowed: deps.security.allowCustomTargets,
      mockApi: deps.mock ? { apiUrl: deps.mock.apiUrl, token: deps.mock.token } : null,
      envVars: ENV_VARS,
      maxGeneratedPatients: MAX_GENERATED_PATIENTS,
    });
  });

  api.get('/sample', async (_request, response) => {
    const csv = await readFile(deps.paths.sampleCsv, 'utf8');
    response.json({ fileName: 'patients.csv', csv });
  });

  api.post('/datasets/generate', (request, response) => {
    const body = (request.body ?? {}) as { patients?: unknown; seed?: unknown };
    const patients = Number(body.patients ?? 1000);
    const seed = Number(body.seed ?? 42);
    if (!Number.isInteger(patients) || patients < 1 || patients > MAX_GENERATED_PATIENTS) {
      throw new HttpError(400, `patients must be an integer between 1 and ${MAX_GENERATED_PATIENTS}`);
    }
    if (!Number.isInteger(seed)) throw new HttpError(400, 'seed must be an integer');
    response.json(generateDataset({ patients, seed }));
  });

  api.post('/transform', (request, response) => {
    response.json(transformCsv(requireCsv(request.body)));
  });

  api.post('/runs', (request, response) => {
    const body = request.body as { settings?: unknown; target?: unknown };
    const csv = requireCsv(body);
    const target = parseTarget(body.target, deps.security.allowCustomTargets);
    const active = deps.runs.activeRun();
    if (active) throw new HttpError(409, `Run ${active.id} is still in progress; wait for it to finish or cancel it.`);

    const { settings, errors } = resolveIngestionSettings(body.settings);
    if (errors.length > 0) throw new HttpError(400, 'Invalid ingestion settings', errors);

    let apiUrl: string;
    let apiToken: string;
    if (target.kind === 'mock') {
      if (!deps.mock) throw new HttpError(400, 'The mock SHC API is not running (START_MOCK_API=false).');
      apiUrl = deps.mock.apiUrl;
      apiToken = target.apiToken ?? deps.mock.token;
    } else {
      apiUrl = target.apiUrl;
      apiToken = target.apiToken;
    }

    const transform = transformCsv(csv);
    if (transform.records.length === 0) throw new HttpError(422, 'No valid records remain after normalisation; nothing to load.');
    const run = deps.runs.start({
      transform,
      fileName: fileNameOf(body, 'upload.csv'),
      config: { ...settings, apiUrl, apiToken },
      target: target.kind,
    });
    response.status(202).json(deps.runs.view(run));
  });

  api.get('/runs', (_request, response) => {
    response.json(deps.runs.list());
  });

  api.get('/runs/:id', (request, response) => {
    const run = deps.runs.get(String(request.params.id));
    if (!run) throw new HttpError(404, 'Run not found');
    response.json(deps.runs.view(run));
  });

  api.get('/runs/:id/events', (request, response) => streamRunEvents(deps, request, response));

  api.post('/runs/:id/cancel', (request, response) => {
    const run = deps.runs.get(String(request.params.id));
    if (!run) throw new HttpError(404, 'Run not found');
    response.json({ cancelled: deps.runs.cancel(run.id) });
  });

  api.get('/runs/:id/failed-records', (request, response) => {
    const run = deps.runs.get(String(request.params.id));
    if (!run) throw new HttpError(404, 'Run not found');
    if (request.query.download !== undefined) response.attachment('failed_records.json');
    response.type('application/json').send(`${JSON.stringify(run.failedRecords.entries, null, 2)}\n`);
  });

  const requireMock = () => {
    if (!deps.mock) throw new HttpError(404, 'The mock SHC API is not running (START_MOCK_API=false).');
    return deps.mock;
  };

  api.get('/mock', (_request, response) => {
    const mock = requireMock();
    response.json({ apiUrl: mock.apiUrl, ...mock.store.snapshot() });
  });

  api.put('/mock/settings', (request, response) => {
    const mock = requireMock();
    const { settings, errors } = mock.store.updateSettings(request.body);
    if (errors.length > 0) throw new HttpError(400, 'Invalid mock API settings', errors);
    response.json(settings);
  });

  api.get('/mock/patients', (request, response) => {
    const mock = requireMock();
    const query = typeof request.query.q === 'string' ? request.query.q : undefined;
    response.json(
      mock.store.listPatients({
        offset: Number(request.query.offset ?? 0) || 0,
        limit: Number(request.query.limit ?? 50) || 50,
        ...(query ? { query } : {}),
      }),
    );
  });

  api.delete('/mock/patients', (_request, response) => {
    const mock = requireMock();
    mock.store.reset();
    response.json({ apiUrl: mock.apiUrl, ...mock.store.snapshot() });
  });

  api.get('/deliverables', async (_request, response) => {
    const items = await Promise.all(
      deliverables(deps.paths).map(async ({ file, ...item }) => ({
        ...item,
        path: relative(deps.paths.repoRoot, file).replace(/\\/g, '/'),
        content: await readFile(file, 'utf8').catch(() => null),
      })),
    );
    response.json(items);
  });

  api.use((request, response) => {
    response.status(404).json({ error: 'not_found', message: `No API route for ${request.method} ${request.originalUrl}` });
  });

  api.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: 'request_failed', message: error.message, details: error.details ?? null });
      return;
    }
    if (error instanceof CsvFormatError) {
      response.status(422).json({ error: 'csv_format', message: error.message });
      return;
    }
    const type = (error as { type?: string } | null)?.type;
    if (type === 'entity.too.large') {
      response.status(413).json({ error: 'payload_too_large', message: 'The uploaded file is too large (max 30 MB).' });
      return;
    }
    if (type === 'entity.parse.failed') {
      response.status(400).json({ error: 'bad_json', message: 'Request body is not valid JSON.' });
      return;
    }
    // Other client errors raised by middleware (e.g. 415 unsupported charset) keep their status.
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      response.status(status).json({ error: 'request_failed', message: errorMessage(error) });
      return;
    }
    deps.logger.error('Unhandled API error', { path: request.path, error: errorMessage(error) });
    response.status(500).json({ error: 'internal_error', message: 'Unexpected server error.' });
  });

  app.use('/api', api);

  const { staticDir } = deps.paths;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api\/).*/, (_request, response) => response.sendFile(join(staticDir, 'index.html')));
  }
  return app;
}
