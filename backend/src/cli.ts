import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, ENV_VARS, loadConsoleConfig, loadMockApiConfig, loadPipelineConfig } from './config/env.js';
import { REPO_ROOT } from './config/paths.js';
import { CsvFormatError } from './etl/csvReader.js';
import { transformCsv, type TransformResult } from './etl/transform.js';
import { FailedRecordsLog } from './ingest/failedRecords.js';
import { runIngestion } from './ingest/pipeline.js';
import type { IngestionEvent, RunSummary } from './ingest/types.js';
import { startMockApi } from './mock-api/start.js';
import { buildRunReport } from './reporting/runReport.js';
import { startConsole } from './server/start.js';
import { errorMessage } from './shared/async.js';
import { writeJsonAtomic } from './shared/fs.js';
import { createLogger, type Logger } from './shared/logger.js';
import { generateDataset, MAX_GENERATED_PATIENTS } from './tools/generateDataset.js';

export const EXIT_CODES = { ok: 0, fatal: 1, partial: 2, cancelled: 130 } as const;

function helpText(): string {
  const pipelineVars = ENV_VARS.filter((spec) => spec.scope === 'pipeline').map(
    (spec) => `  ${spec.name.padEnd(24)} ${spec.description} [default: ${spec.defaultValue}]`,
  );
  return [
    'shc-ingest: GlobalHealth Corp legacy CSV -> SHC Platform ingestion pipeline',
    '',
    'Usage: shc-ingest [command] [options]',
    '',
    'Commands:',
    '  ingest       Extract, normalise and load INPUT_FILE into the SHC API (default)',
    '  transform    Extract and normalise only; write normalized_records.json, no API calls',
    '  generate     Write a synthetic messy CSV: --patients <n> --seed <n> --out <file>',
    '  mock-api     Start the mock SHC Platform API (MOCK_API_PORT, MOCK_API_TOKEN)',
    '  serve        Start the migration console API (plus mock API and built UI)',
    '  help         Show this help',
    '',
    'Configuration (environment variables):',
    ...pipelineVars,
    '',
    'Exit codes: 0 all records loaded | 1 fatal error or run aborted | 2 finished with failed records | 130 cancelled',
  ].join('\n');
}

function createEventLogger(logger: Logger): (event: IngestionEvent) => void {
  let lastProgressAt = Number.NEGATIVE_INFINITY;
  return (event) => {
    switch (event.type) {
      case 'run_started':
        logger.info('Load started', {
          runId: event.runId,
          apiUrl: event.apiUrl,
          records: event.totalRecords,
          batches: event.totalBatches,
          batchSize: event.settings.batchSize,
          maxRequestsPerSecond: event.settings.maxRequestsPerSecond,
        });
        break;
      case 'request_completed': {
        const fields = {
          batch: event.batchId,
          attempt: event.attempt,
          records: event.size,
          status: event.status ?? 'network',
          durationMs: event.durationMs,
        };
        if (event.outcome === 'success') logger.debug('Batch accepted', fields);
        else logger.warn('Request failed', { ...fields, outcome: event.outcome, detail: event.message });
        break;
      }
      case 'retry_scheduled':
        logger.warn('Retry scheduled', { batch: event.batchId, nextAttempt: event.nextAttempt, delayMs: event.delayMs, cause: event.reason });
        break;
      case 'records_isolated':
        logger.warn('Batch rejected with 400; the API named the invalid records', {
          batch: event.batchId,
          records: event.size,
          invalid: event.invalid,
          resentAs: event.retryBatchId,
        });
        break;
      case 'batch_bisected':
        logger.warn('Batch rejected with 400; bisecting to isolate the invalid records', {
          batch: event.batchId,
          records: event.size,
          into: event.children,
        });
        break;
      case 'records_failed':
        logger.error('Records written to failed_records.json', {
          batch: event.batchId,
          reason: event.reason,
          status: event.status,
          count: event.patientIds.length,
          patientIds: event.patientIds.slice(0, 25),
          detail: event.message,
        });
        break;
      case 'run_aborting':
        logger.error('Aborting run', { reason: event.reason, status: event.status });
        break;
      case 'progress':
        if (event.pending === 0 || event.elapsedMs - lastProgressAt >= 2000) {
          lastProgressAt = event.elapsedMs;
          logger.info('Progress', {
            loaded: event.loaded,
            failed: event.failed,
            pending: event.pending,
            total: event.total,
            requests: event.requests,
          });
        }
        break;
      case 'run_finished':
        break;
    }
  };
}

function logTransform(logger: Logger, transform: TransformResult): void {
  const { stats } = transform;
  logger.info('Extract and normalise complete', {
    rows: stats.totalRows,
    readyToLoad: stats.recordsReady,
    duplicatesRemoved: stats.duplicateRowsRemoved,
    repairedRows: stats.repairedRows,
    quarantinedRows: stats.rejectedRows,
    datesNormalized: stats.datesNormalized,
    missingEmail: stats.missingEmail,
    missingPhone: stats.missingPhone,
  });
  for (const item of transform.anomalySummary) {
    const log = item.severity === 'info' ? logger.info : logger.warn;
    log('Data anomaly', { code: item.code, severity: item.severity, rows: item.count, title: item.title });
  }
  // Codes and line numbers only: messages quote field values, which can be PHI.
  for (const row of transform.rows) {
    if (row.status !== 'rejected') continue;
    logger.warn('Row quarantined', {
      line: row.line,
      patientId: row.patientId,
      reasons: row.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
    });
  }
}

/**
 * Keeps the previous run's failures, and the journal of a run that was
 * interrupted before it could write them out, instead of overwriting them.
 */
async function archivePrevious(path: string, logger: Logger): Promise<void> {
  const candidates = [
    { file: path, suffix: '.json', minBytes: 4 }, // "[]\n" is not worth keeping
    { file: `${path}.partial.ndjson`, suffix: '.partial.ndjson', minBytes: 1 },
  ];
  for (const { file, suffix, minBytes } of candidates) {
    try {
      const info = await stat(file);
      if (info.size < minBytes) continue;
      const archived = `${path.replace(/\.json$/i, '')}.${info.mtime.toISOString().replace(/[:.]/g, '-')}${suffix}`;
      await rename(file, archived);
      logger.info("Archived the previous run's failed records", { archived });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function exitCodeFor(summary: RunSummary): number {
  switch (summary.status) {
    case 'succeeded':
      return EXIT_CODES.ok;
    case 'completed_with_failures':
      return EXIT_CODES.partial;
    case 'cancelled':
      return EXIT_CODES.cancelled;
    case 'aborted':
      return EXIT_CODES.fatal;
  }
}

async function ingestCommand(options: { dryRun: boolean }): Promise<number> {
  const config = loadPipelineConfig(process.env, options.dryRun ? { dryRun: true } : {});
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  logger.info('Reading legacy export', { inputFile: config.inputFile, dryRun: config.dryRun });

  let csv: string;
  try {
    csv = await readFile(config.inputFile, 'utf8');
  } catch (error) {
    logger.error('Cannot read the input file', {
      inputFile: config.inputFile,
      error: (error as NodeJS.ErrnoException).code ?? errorMessage(error),
    });
    return EXIT_CODES.fatal;
  }

  let transform: TransformResult;
  try {
    transform = transformCsv(csv);
  } catch (error) {
    if (error instanceof CsvFormatError) {
      logger.error(error.message, { inputFile: config.inputFile });
      return EXIT_CODES.fatal;
    }
    throw error;
  }
  logTransform(logger, transform);

  await mkdir(config.outputDir, { recursive: true });
  const reportFile = join(config.outputDir, 'run_report.json');

  if (config.dryRun) {
    const normalizedFile = join(config.outputDir, 'normalized_records.json');
    await writeJsonAtomic(normalizedFile, transform.records);
    await writeJsonAtomic(reportFile, buildRunReport({ sourceFile: config.inputFile, transform, summary: null }));
    logger.info('Dry run complete; nothing was sent to the SHC API', { normalizedFile, reportFile });
    return EXIT_CODES.ok;
  }

  if (transform.records.length === 0) {
    await writeJsonAtomic(reportFile, buildRunReport({ sourceFile: config.inputFile, transform, summary: null }));
    logger.error('No valid records remain after normalisation; nothing to load', { reportFile });
    return EXIT_CODES.fatal;
  }

  await archivePrevious(config.failedRecordsFile, logger);
  const failedRecords = new FailedRecordsLog(config.failedRecordsFile);
  try {
    // Prove the output location is writable before sending anything (e.g. a root-owned bind mount).
    await failedRecords.flush();
  } catch (error) {
    logger.error('The output location is not writable; nothing was sent to the SHC API', {
      failedRecordsFile: config.failedRecordsFile,
      error: (error as NodeJS.ErrnoException).code ?? errorMessage(error),
    });
    return EXIT_CODES.fatal;
  }
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    logger.warn(`${signal} received: no new requests will be sent; waiting for in-flight requests`);
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const summary = await runIngestion(transform.records, config.ingestion, {
    signal: controller.signal,
    failedRecords,
    onEvent: createEventLogger(logger),
  });
  await writeJsonAtomic(reportFile, buildRunReport({ sourceFile: config.inputFile, transform, summary }));

  const log = summary.status === 'succeeded' ? logger.info : logger.warn;
  log('Load finished', {
    status: summary.status,
    loaded: summary.records.loaded,
    failed: summary.records.failed,
    notAttempted: summary.records.notAttempted,
    requests: summary.requests.total,
    retried: summary.requests.retried,
    peakRequestsPerSecond: summary.requests.peakPerSecond,
    durationMs: summary.durationMs,
    ...(summary.abortReason ? { abortReason: summary.abortReason } : {}),
    failedRecordsFile: config.failedRecordsFile,
    reportFile,
  });
  return exitCodeFor(summary);
}

async function generateCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      patients: { type: 'string', default: '1000' },
      seed: { type: 'string', default: '42' },
      out: { type: 'string' },
    },
  });
  const patients = Number(values.patients);
  const seed = Number(values.seed);
  if (!Number.isInteger(patients) || patients < 1 || patients > MAX_GENERATED_PATIENTS) {
    console.error(`--patients must be an integer between 1 and ${MAX_GENERATED_PATIENTS}`);
    return EXIT_CODES.fatal;
  }
  if (!Number.isInteger(seed)) {
    console.error('--seed must be an integer');
    return EXIT_CODES.fatal;
  }
  const dataset = generateDataset({ patients, seed });
  const out = resolve(values.out ?? join('data', dataset.fileName));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, dataset.csv, 'utf8');
  console.log(`Wrote ${dataset.rows} rows (${dataset.patients} patients, seed ${dataset.seed}) to ${out}`);
  return EXIT_CODES.ok;
}

function keepAliveUntilSignal(close: () => Promise<void>): null {
  const stop = () => void close().then(() => process.exit(EXIT_CODES.ok));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return null;
}

async function mockApiCommand(): Promise<null> {
  const config = loadMockApiConfig();
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  const handle = await startMockApi({
    host: config.host,
    port: config.port,
    token: config.token,
    settings: { failureRate: config.failureRate, throttleRate: config.throttleRate },
    logger,
  });
  return keepAliveUntilSignal(handle.close);
}

async function serveCommand(): Promise<null> {
  const config = loadConsoleConfig(process.env, { repoRoot: REPO_ROOT });
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  const handle = await startConsole(config, logger);
  return keepAliveUntilSignal(handle.close);
}

/** Resolves to an exit code, or null for long-running servers. */
async function main(argv: string[]): Promise<number | null> {
  const [command = 'ingest', ...rest] = argv;
  switch (command) {
    case 'ingest':
      return ingestCommand({ dryRun: false });
    case 'transform':
      return ingestCommand({ dryRun: true });
    case 'generate':
      return generateCommand(rest);
    case 'mock-api':
      return mockApiCommand();
    case 'serve':
      return serveCommand();
    case 'help':
    case '--help':
    case '-h':
      console.log(helpText());
      return EXIT_CODES.ok;
    default:
      console.error(`Unknown command "${command}".\n\n${helpText()}`);
      return EXIT_CODES.fatal;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = EXIT_CODES.fatal;
  },
);
