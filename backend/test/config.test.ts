import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, ENV_VARS, loadPipelineConfig } from '../src/config/env.js';
import { resolveIngestionSettings } from '../src/ingest/settings.js';
import { tempDir } from './helpers.js';

describe('loadPipelineConfig', () => {
  it('applies safe defaults that match the API contract', () => {
    const config = loadPipelineConfig({ SHC_API_TOKEN: 'secret' });
    expect(config.ingestion).toMatchObject({
      apiUrl: 'https://api.mock-shc.com/v1/patients',
      apiToken: 'secret',
      batchSize: 100,
      maxRequestsPerSecond: 5,
      maxRetries: 5,
      bisectOn400: true,
    });
    expect(config.failedRecordsFile.endsWith('failed_records.json')).toBe(true);
  });

  it('requires a token unless DRY_RUN is set', () => {
    expect(() => loadPipelineConfig({})).toThrow(ConfigError);
    expect(loadPipelineConfig({ DRY_RUN: 'true' }).dryRun).toBe(true);
  });

  it('reads the token from SHC_API_TOKEN_FILE (Docker / Kubernetes secrets)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'token');
    await writeFile(file, 'from-file\n');
    expect(loadPipelineConfig({ SHC_API_TOKEN: 'from-env', SHC_API_TOKEN_FILE: file }).ingestion.apiToken).toBe('from-file');
  });

  it('reports every invalid value at once', () => {
    try {
      loadPipelineConfig({ SHC_API_TOKEN: 't', BATCH_SIZE: '500', MAX_RETRIES: 'many', SHC_API_URL: 'ftp://x', BISECT_ON_400: 'maybe' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      for (const name of ['BATCH_SIZE', 'MAX_RETRIES', 'SHC_API_URL', 'BISECT_ON_400']) expect(message).toContain(name);
    }
  });

  it('rejects credentials in the URL without echoing them, and tokens that cannot go in a header', () => {
    try {
      loadPipelineConfig({ SHC_API_TOKEN: 't', SHC_API_URL: 'https://user:s3cret@api.example.com/v1/patients' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('must not contain credentials');
      expect((error as Error).message).not.toContain('s3cret');
    }
    expect(() => loadPipelineConfig({ SHC_API_TOKEN: 'tök€n' })).toThrow(/printable ASCII/);
  });

  it('documents every variable it reads', () => {
    const documented = new Set(ENV_VARS.map((spec) => spec.name));
    for (const name of ['SHC_API_URL', 'SHC_API_TOKEN', 'SHC_API_TOKEN_FILE', 'INPUT_FILE', 'OUTPUT_DIR', 'BATCH_SIZE', 'MAX_REQUESTS_PER_SECOND', 'MAX_RETRIES']) {
      expect(documented.has(name)).toBe(true);
    }
  });
});

describe('resolveIngestionSettings', () => {
  it('validates UI overrides against the same limits', () => {
    expect(resolveIngestionSettings({ batchSize: 50, bisectOn400: false }).settings).toMatchObject({ batchSize: 50, bisectOn400: false });
    expect(resolveIngestionSettings({ batchSize: 101 }).errors).toHaveLength(1);
    expect(resolveIngestionSettings({ backoffBaseMs: 5000, backoffMaxMs: 1000 }).errors).toHaveLength(1);
  });
});
