import type { PatientRecord } from '../domain/patient.js';

/** Behaviour of the mock SHC API; adjustable at runtime from the console. */
export interface MockApiSettings {
  requireAuth: boolean;
  enforceRateLimit: boolean;
  maxRequestsPerSecond: number;
  maxBatchSize: number;
  validateRecords: boolean;
  /** Probability (0-1) that a request fails with an injected 500/502/503. */
  failureRate: number;
  /** Probability (0-1) that a request is throttled with an injected 429. */
  throttleRate: number;
  latencyMinMs: number;
  latencyMaxMs: number;
}

export const DEFAULT_MOCK_SETTINGS: Readonly<MockApiSettings> = {
  requireAuth: true,
  enforceRateLimit: true,
  maxRequestsPerSecond: 5,
  maxBatchSize: 100,
  validateRecords: true,
  failureRate: 0,
  throttleRate: 0,
  latencyMinMs: 20,
  latencyMaxMs: 80,
};

const NUMERIC_LIMITS: Record<
  'maxRequestsPerSecond' | 'maxBatchSize' | 'failureRate' | 'throttleRate' | 'latencyMinMs' | 'latencyMaxMs',
  [number, number]
> = {
  maxRequestsPerSecond: [1, 100],
  maxBatchSize: [1, 1000],
  failureRate: [0, 1],
  throttleRate: [0, 1],
  latencyMinMs: [0, 5000],
  latencyMaxMs: [0, 5000],
};
const BOOLEAN_SETTINGS = ['requireAuth', 'enforceRateLimit', 'validateRecords'] as const;

export interface StoredPatient extends PatientRecord {
  received_at: string;
  version: number;
}

export interface MockRequestLogEntry {
  id: number;
  at: string;
  status: number;
  records: number;
  durationMs: number;
  note: string;
}

export interface MockStats {
  requests: number;
  byStatus: Record<string, number>;
  recordsAccepted: number;
  created: number;
  updated: number;
  staleIgnored: number;
  /** Highest number of requests received in any one-second window (before throttling). */
  peakArrivalsPerSecond: number;
  lastRequestAt: string | null;
}

const LOG_LIMIT = 300;

const emptyStats = (): MockStats => ({
  requests: 0,
  byStatus: {},
  recordsAccepted: 0,
  created: 0,
  updated: 0,
  staleIgnored: 0,
  peakArrivalsPerSecond: 0,
  lastRequestAt: null,
});

/** In-memory state of the mock SHC Platform: stored patients, rate-limit windows, request log. */
export class MockShcStore {
  readonly tokens: ReadonlySet<string>;
  private current: MockApiSettings;
  private readonly patients = new Map<string, StoredPatient>();
  private log: MockRequestLogEntry[] = [];
  private admitted: number[] = [];
  private arrivals: number[] = [];
  private nextRequestId = 1;
  private stats = emptyStats();

  constructor(options: { tokens: readonly string[]; settings?: Partial<MockApiSettings> }) {
    this.tokens = new Set(options.tokens.filter(Boolean));
    this.current = { ...DEFAULT_MOCK_SETTINGS, ...options.settings };
  }

  get settings(): MockApiSettings {
    return { ...this.current };
  }

  updateSettings(patch: unknown): { settings: MockApiSettings; errors: string[] } {
    const errors: string[] = [];
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return { settings: this.settings, errors: ['settings must be an object'] };
    }
    const values = patch as Record<string, unknown>;
    const next = { ...this.current };
    for (const [key, [min, max]] of Object.entries(NUMERIC_LIMITS) as Array<[keyof typeof NUMERIC_LIMITS, [number, number]]>) {
      if (values[key] === undefined) continue;
      const value = Number(values[key]);
      if (!Number.isFinite(value) || value < min || value > max) errors.push(`${key} must be between ${min} and ${max}`);
      else next[key] = value;
    }
    for (const key of BOOLEAN_SETTINGS) {
      if (values[key] === undefined) continue;
      if (typeof values[key] !== 'boolean') errors.push(`${key} must be a boolean`);
      else next[key] = values[key];
    }
    if (next.latencyMaxMs < next.latencyMinMs) errors.push('latencyMaxMs must be >= latencyMinMs');
    if (errors.length === 0) this.current = next;
    return { settings: this.settings, errors };
  }

  isAuthorized(token: string): boolean {
    return this.tokens.has(token);
  }

  /** Tracks every incoming request, to report how fast clients actually call the API. */
  noteArrival(now: number): void {
    this.arrivals = this.arrivals.filter((at) => at > now - 1000);
    this.arrivals.push(now);
    this.stats.peakArrivalsPerSecond = Math.max(this.stats.peakArrivalsPerSecond, this.arrivals.length);
  }

  /** Sliding one-second window. Throttled requests do not count against the window. */
  admit(now: number): { allowed: true } | { allowed: false; retryAfterMs: number } {
    this.admitted = this.admitted.filter((at) => at > now - 1000);
    if (this.admitted.length >= this.current.maxRequestsPerSecond) {
      const oldest = this.admitted[0] ?? now;
      return { allowed: false, retryAfterMs: Math.max(1, oldest + 1000 - now) };
    }
    this.admitted.push(now);
    return { allowed: true };
  }

  /**
   * Upserts by patient_id. An incoming record older than the stored one is
   * ignored, so replays and retries can never roll a patient back in time.
   */
  upsert(records: readonly PatientRecord[], now: Date): { created: number; updated: number; stale: number } {
    let created = 0;
    let updated = 0;
    let stale = 0;
    for (const record of records) {
      const existing = this.patients.get(record.patient_id);
      if (existing && Date.parse(existing.last_modified) > Date.parse(record.last_modified)) {
        stale += 1;
        continue;
      }
      this.patients.set(record.patient_id, {
        ...record,
        received_at: now.toISOString(),
        version: (existing?.version ?? 0) + 1,
      });
      if (existing) updated += 1;
      else created += 1;
    }
    this.stats.recordsAccepted += records.length;
    this.stats.created += created;
    this.stats.updated += updated;
    this.stats.staleIgnored += stale;
    return { created, updated, stale };
  }

  recordRequest(entry: Omit<MockRequestLogEntry, 'id' | 'at'>, now: Date = new Date()): void {
    const at = now.toISOString();
    this.stats.requests += 1;
    this.stats.byStatus[String(entry.status)] = (this.stats.byStatus[String(entry.status)] ?? 0) + 1;
    this.stats.lastRequestAt = at;
    this.log.push({ id: this.nextRequestId++, at, ...entry });
    if (this.log.length > LOG_LIMIT) this.log = this.log.slice(-LOG_LIMIT);
  }

  get patientCount(): number {
    return this.patients.size;
  }

  listPatients(options: { offset?: number; limit?: number; query?: string } = {}): { total: number; items: StoredPatient[] } {
    const query = options.query?.trim().toLowerCase();
    let items = [...this.patients.values()];
    if (query) {
      items = items.filter((patient) =>
        [patient.patient_id, patient.first_name, patient.last_name, patient.email ?? ''].some((value) =>
          value.toLowerCase().includes(query),
        ),
      );
    }
    items.sort((a, b) => a.patient_id.localeCompare(b.patient_id, 'en', { numeric: true }));
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  snapshot(recentLimit = 50) {
    return {
      settings: this.settings,
      stats: { ...this.stats, byStatus: { ...this.stats.byStatus } },
      patientCount: this.patients.size,
      recentRequests: this.log.slice(-recentLimit).reverse(),
    };
  }

  /** Clears stored patients, statistics and the request log (settings are kept). */
  reset(): void {
    this.patients.clear();
    this.log = [];
    this.admitted = [];
    this.arrivals = [];
    this.stats = emptyStats();
  }
}
