import type { IngestionSettings } from './types.js';

export const SHC_MAX_BATCH_SIZE = 100;
export const SHC_MAX_REQUESTS_PER_SECOND = 5;

export const DEFAULT_INGESTION_SETTINGS: Readonly<IngestionSettings> = {
  batchSize: SHC_MAX_BATCH_SIZE,
  maxRequestsPerSecond: SHC_MAX_REQUESTS_PER_SECOND,
  rateLimitSafetyMs: 50,
  maxRetries: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  requestTimeoutMs: 30_000,
  concurrency: 2,
  bisectOn400: true,
};

type NumericSetting = Exclude<keyof IngestionSettings, 'bisectOn400'>;

export const INGESTION_LIMITS: Readonly<Record<NumericSetting, { min: number; max: number; integer: boolean }>> = {
  batchSize: { min: 1, max: SHC_MAX_BATCH_SIZE, integer: true },
  maxRequestsPerSecond: { min: 0.1, max: 50, integer: false },
  rateLimitSafetyMs: { min: 0, max: 1_000, integer: true },
  maxRetries: { min: 0, max: 10, integer: true },
  backoffBaseMs: { min: 1, max: 60_000, integer: true },
  backoffMaxMs: { min: 1, max: 300_000, integer: true },
  requestTimeoutMs: { min: 100, max: 300_000, integer: true },
  concurrency: { min: 1, max: 10, integer: true },
};

/**
 * Validates a partial settings object (from the console UI) against the same
 * limits the environment-variable loader enforces.
 */
export function resolveIngestionSettings(input: unknown): { settings: IngestionSettings; errors: string[] } {
  const settings: IngestionSettings = { ...DEFAULT_INGESTION_SETTINGS };
  const errors: string[] = [];
  if (input === undefined || input === null) return { settings, errors };
  if (typeof input !== 'object' || Array.isArray(input)) return { settings, errors: ['settings must be an object'] };

  const values = input as Record<string, unknown>;
  for (const [key, limit] of Object.entries(INGESTION_LIMITS) as Array<[NumericSetting, (typeof INGESTION_LIMITS)[NumericSetting]]>) {
    const value = values[key];
    if (value === undefined || value === null || value === '') continue;
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number) || number < limit.min || number > limit.max || (limit.integer && !Number.isInteger(number))) {
      errors.push(`${key} must be ${limit.integer ? 'an integer' : 'a number'} between ${limit.min} and ${limit.max}`);
      continue;
    }
    settings[key] = number;
  }
  if (values.bisectOn400 !== undefined) {
    if (typeof values.bisectOn400 !== 'boolean') errors.push('bisectOn400 must be a boolean');
    else settings.bisectOn400 = values.bisectOn400;
  }
  if (settings.backoffMaxMs < settings.backoffBaseMs) errors.push('backoffMaxMs must be >= backoffBaseMs');
  return { settings, errors };
}
