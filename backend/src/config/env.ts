import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_INGESTION_SETTINGS, INGESTION_LIMITS } from '../ingest/settings.js';
import type { IngestionConfig } from '../ingest/types.js';
import type { LogFormat, LogLevel } from '../shared/logger.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export const DEFAULT_SHC_API_URL = 'https://api.mock-shc.com/v1/patients';
export const DEFAULT_MOCK_API_TOKEN = 'local-dev-token';

export type EnvScope = 'pipeline' | 'console' | 'mock-api';

export interface EnvVarSpec {
  name: string;
  defaultValue: string;
  description: string;
  scope: EnvScope;
  secret?: boolean;
}

/** Single source of truth for configuration: drives the loaders, `--help`, the console UI and the docs. */
export const ENV_VARS: readonly EnvVarSpec[] = [
  { scope: 'pipeline', name: 'SHC_API_URL', defaultValue: DEFAULT_SHC_API_URL, description: 'SHC Platform patients endpoint (POST).' },
  { scope: 'pipeline', name: 'SHC_API_TOKEN', defaultValue: '(required)', description: 'Bearer token for the SHC API. Required unless DRY_RUN=true.', secret: true },
  { scope: 'pipeline', name: 'SHC_API_TOKEN_FILE', defaultValue: '(unset)', description: 'Path to a file holding the token (Docker/Kubernetes secret). Overrides SHC_API_TOKEN.', secret: true },
  { scope: 'pipeline', name: 'INPUT_FILE', defaultValue: './data/patients.csv', description: 'Legacy CSV export to ingest (/data/input/patients.csv in the container).' },
  { scope: 'pipeline', name: 'OUTPUT_DIR', defaultValue: './output', description: 'Where failed_records.json and run_report.json are written (/data/output in the container).' },
  { scope: 'pipeline', name: 'FAILED_RECORDS_FILE', defaultValue: '<OUTPUT_DIR>/failed_records.json', description: 'Override the failed-records path.' },
  { scope: 'pipeline', name: 'BATCH_SIZE', defaultValue: String(DEFAULT_INGESTION_SETTINGS.batchSize), description: 'Records per request (1-100; the API maximum is 100).' },
  { scope: 'pipeline', name: 'MAX_REQUESTS_PER_SECOND', defaultValue: String(DEFAULT_INGESTION_SETTINGS.maxRequestsPerSecond), description: 'Client-side rate limit; must not exceed the API limit of 5.' },
  { scope: 'pipeline', name: 'RATE_LIMIT_SAFETY_MS', defaultValue: String(DEFAULT_INGESTION_SETTINGS.rateLimitSafetyMs), description: 'Extra spacing per one-second window to absorb network jitter.' },
  { scope: 'pipeline', name: 'MAX_RETRIES', defaultValue: String(DEFAULT_INGESTION_SETTINGS.maxRetries), description: 'Retries per batch for 408/429/5xx/network errors.' },
  { scope: 'pipeline', name: 'BACKOFF_BASE_MS', defaultValue: String(DEFAULT_INGESTION_SETTINGS.backoffBaseMs), description: 'First retry delay; doubles on every further retry (with jitter).' },
  { scope: 'pipeline', name: 'BACKOFF_MAX_MS', defaultValue: String(DEFAULT_INGESTION_SETTINGS.backoffMaxMs), description: 'Upper bound for a single backoff delay.' },
  { scope: 'pipeline', name: 'REQUEST_TIMEOUT_MS', defaultValue: String(DEFAULT_INGESTION_SETTINGS.requestTimeoutMs), description: 'Per-request timeout (a timeout is retried).' },
  { scope: 'pipeline', name: 'CONCURRENCY', defaultValue: String(DEFAULT_INGESTION_SETTINGS.concurrency), description: 'Batches in flight at once; the rate limiter still caps requests per second.' },
  { scope: 'pipeline', name: 'BISECT_ON_400', defaultValue: String(DEFAULT_INGESTION_SETTINGS.bisectOn400), description: 'Split a rejected batch to isolate the offending records.' },
  { scope: 'pipeline', name: 'DRY_RUN', defaultValue: 'false', description: 'Normalise only: write normalized_records.json and skip the API.' },
  { scope: 'pipeline', name: 'LOG_LEVEL', defaultValue: 'info', description: 'debug | info | warn | error' },
  { scope: 'pipeline', name: 'LOG_FORMAT', defaultValue: 'json', description: 'json (one object per line, for log shippers) | pretty' },
  { scope: 'console', name: 'PORT', defaultValue: '4000', description: 'Port of the migration console API (and built UI).' },
  { scope: 'console', name: 'HOST', defaultValue: '127.0.0.1', description: 'Bind address of the console and mock API. The console has no login: only widen it on a trusted network.' },
  { scope: 'console', name: 'ALLOW_CUSTOM_TARGETS', defaultValue: 'true on 127.0.0.1, false otherwise', description: 'Whether the UI may send data to any URL (not just the mock SHC API).' },
  { scope: 'console', name: 'START_MOCK_API', defaultValue: 'true', description: 'Start the mock SHC API alongside the console.' },
  { scope: 'console', name: 'STATIC_DIR', defaultValue: '../frontend/dist', description: 'Built UI to serve, if present.' },
  { scope: 'mock-api', name: 'MOCK_API_PORT', defaultValue: '4010', description: 'Port of the mock SHC Platform API.' },
  { scope: 'mock-api', name: 'MOCK_API_TOKEN', defaultValue: DEFAULT_MOCK_API_TOKEN, description: 'Bearer token the mock API accepts (development only).', secret: true },
  { scope: 'mock-api', name: 'MOCK_FAILURE_RATE', defaultValue: '0', description: 'Probability (0-1) of an injected 5xx response.' },
  { scope: 'mock-api', name: 'MOCK_THROTTLE_RATE', defaultValue: '0', description: 'Probability (0-1) of an injected 429 response.' },
];

type Env = Readonly<Record<string, string | undefined>>;

/** Why a URL is unusable as an API endpoint, or null if it is fine. */
export function describeUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be an http(s) URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must be an http(s) URL';
  if (url.username || url.password) return 'must not contain credentials; use the Bearer token instead';
  return null;
}

/** Bearer tokens go into an HTTP header: printable ASCII only, no spaces. */
export function isValidToken(token: string): boolean {
  return /^[\x21-\x7E]+$/.test(token);
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

class EnvReader {
  readonly errors: string[] = [];
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  text(name: string): string | undefined {
    const value = this.env[name]?.trim();
    return value ? value : undefined;
  }

  string(name: string, fallback: string): string {
    return this.text(name) ?? fallback;
  }

  number(name: string, fallback: number, limits: { min: number; max: number; integer?: boolean }): number {
    const raw = this.text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < limits.min || value > limits.max || (limits.integer && !Number.isInteger(value))) {
      this.errors.push(`${name} must be ${limits.integer ? 'an integer' : 'a number'} between ${limits.min} and ${limits.max} (got "${raw}")`);
      return fallback;
    }
    return value;
  }

  boolean(name: string, fallback: boolean): boolean {
    const raw = this.text(name);
    if (raw === undefined) return fallback;
    if (/^(true|1|yes|on)$/i.test(raw)) return true;
    if (/^(false|0|no|off)$/i.test(raw)) return false;
    this.errors.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  }

  oneOf<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
    const raw = this.text(name);
    if (raw === undefined) return fallback;
    const match = allowed.find((option) => option === raw.toLowerCase());
    if (!match) this.errors.push(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
    return match ?? fallback;
  }

  url(name: string, fallback: string): string {
    const raw = this.string(name, fallback);
    const problem = describeUrlProblem(raw);
    if (problem) {
      // Never echo the value: it may contain credentials.
      this.errors.push(`${name} ${problem}`);
      return fallback;
    }
    return new URL(raw).toString();
  }

  assertValid(): void {
    if (this.errors.length > 0) {
      throw new ConfigError(`Invalid configuration:\n  - ${this.errors.join('\n  - ')}`);
    }
  }
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];
const LOG_FORMATS = ['json', 'pretty'] as const satisfies readonly LogFormat[];

export interface PipelineConfig {
  inputFile: string;
  outputDir: string;
  failedRecordsFile: string;
  dryRun: boolean;
  logLevel: LogLevel;
  logFormat: LogFormat;
  ingestion: IngestionConfig;
}

/** Configuration of the ingestion script (CLI / container), read from the environment. */
export function loadPipelineConfig(env: Env = process.env, overrides: { dryRun?: boolean } = {}): PipelineConfig {
  const reader = new EnvReader(env);
  const dryRun = overrides.dryRun ?? reader.boolean('DRY_RUN', false);
  const outputDir = resolve(reader.string('OUTPUT_DIR', './output'));

  let apiToken = reader.text('SHC_API_TOKEN') ?? '';
  const tokenFile = reader.text('SHC_API_TOKEN_FILE');
  if (tokenFile) {
    try {
      apiToken = readFileSync(tokenFile, 'utf8').trim();
    } catch (error) {
      reader.errors.push(`SHC_API_TOKEN_FILE could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`);
    }
  }
  if (!dryRun && !apiToken) {
    reader.errors.push('SHC_API_TOKEN or SHC_API_TOKEN_FILE is required (set DRY_RUN=true to normalise without loading)');
  } else if (apiToken && !isValidToken(apiToken)) {
    reader.errors.push('The SHC API token must be printable ASCII without spaces');
  }

  const defaults = DEFAULT_INGESTION_SETTINGS;
  const ingestion: IngestionConfig = {
    apiUrl: reader.url('SHC_API_URL', DEFAULT_SHC_API_URL),
    apiToken,
    batchSize: reader.number('BATCH_SIZE', defaults.batchSize, INGESTION_LIMITS.batchSize),
    maxRequestsPerSecond: reader.number('MAX_REQUESTS_PER_SECOND', defaults.maxRequestsPerSecond, INGESTION_LIMITS.maxRequestsPerSecond),
    rateLimitSafetyMs: reader.number('RATE_LIMIT_SAFETY_MS', defaults.rateLimitSafetyMs, INGESTION_LIMITS.rateLimitSafetyMs),
    maxRetries: reader.number('MAX_RETRIES', defaults.maxRetries, INGESTION_LIMITS.maxRetries),
    backoffBaseMs: reader.number('BACKOFF_BASE_MS', defaults.backoffBaseMs, INGESTION_LIMITS.backoffBaseMs),
    backoffMaxMs: reader.number('BACKOFF_MAX_MS', defaults.backoffMaxMs, INGESTION_LIMITS.backoffMaxMs),
    requestTimeoutMs: reader.number('REQUEST_TIMEOUT_MS', defaults.requestTimeoutMs, INGESTION_LIMITS.requestTimeoutMs),
    concurrency: reader.number('CONCURRENCY', defaults.concurrency, INGESTION_LIMITS.concurrency),
    bisectOn400: reader.boolean('BISECT_ON_400', defaults.bisectOn400),
  };
  if (ingestion.backoffMaxMs < ingestion.backoffBaseMs) reader.errors.push('BACKOFF_MAX_MS must be >= BACKOFF_BASE_MS');

  const config: PipelineConfig = {
    inputFile: resolve(reader.string('INPUT_FILE', './data/patients.csv')),
    outputDir,
    failedRecordsFile: resolve(reader.string('FAILED_RECORDS_FILE', join(outputDir, 'failed_records.json'))),
    dryRun,
    logLevel: reader.oneOf('LOG_LEVEL', 'info', LOG_LEVELS),
    logFormat: reader.oneOf('LOG_FORMAT', 'json', LOG_FORMATS),
    ingestion,
  };
  reader.assertValid();
  return config;
}

export interface MockApiConfig {
  host: string;
  port: number;
  token: string;
  failureRate: number;
  throttleRate: number;
  logLevel: LogLevel;
  logFormat: LogFormat;
}

export function loadMockApiConfig(env: Env = process.env): MockApiConfig {
  const reader = new EnvReader(env);
  const config: MockApiConfig = {
    host: reader.string('HOST', '127.0.0.1'),
    port: reader.number('MOCK_API_PORT', 4010, { min: 0, max: 65535, integer: true }),
    token: reader.string('MOCK_API_TOKEN', DEFAULT_MOCK_API_TOKEN),
    failureRate: reader.number('MOCK_FAILURE_RATE', 0, { min: 0, max: 1 }),
    throttleRate: reader.number('MOCK_THROTTLE_RATE', 0, { min: 0, max: 1 }),
    logLevel: reader.oneOf('LOG_LEVEL', 'info', LOG_LEVELS),
    logFormat: reader.oneOf('LOG_FORMAT', 'pretty', LOG_FORMATS),
  };
  reader.assertValid();
  return config;
}

export interface ConsoleConfig {
  host: string;
  port: number;
  outputDir: string;
  staticDir: string;
  startMockApi: boolean;
  /** Whether runs may target any URL, not just the bundled mock (SSRF guard). */
  allowCustomTargets: boolean;
  defaultApiUrl: string;
  logLevel: LogLevel;
  logFormat: LogFormat;
  mockApi: MockApiConfig;
}

/** Configuration of the migration console (control-plane API for the UI). */
export function loadConsoleConfig(env: Env = process.env, paths: { repoRoot: string }): ConsoleConfig {
  const reader = new EnvReader(env);
  const mockApi = loadMockApiConfig(env);
  const host = reader.string('HOST', '127.0.0.1');
  const config: ConsoleConfig = {
    host,
    allowCustomTargets: reader.boolean('ALLOW_CUSTOM_TARGETS', isLoopbackHost(host)),
    port: reader.number('PORT', 4000, { min: 0, max: 65535, integer: true }),
    outputDir: resolve(reader.string('OUTPUT_DIR', './output')),
    staticDir: resolve(reader.string('STATIC_DIR', join(paths.repoRoot, 'frontend', 'dist'))),
    startMockApi: reader.boolean('START_MOCK_API', true),
    defaultApiUrl: reader.url('SHC_API_URL', DEFAULT_SHC_API_URL),
    logLevel: reader.oneOf('LOG_LEVEL', 'info', LOG_LEVELS),
    logFormat: reader.oneOf('LOG_FORMAT', 'pretty', LOG_FORMATS),
    mockApi,
  };
  reader.assertValid();
  return config;
}
