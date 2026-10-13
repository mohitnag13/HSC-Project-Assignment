import { join } from 'node:path';
import type { TransformResult, TransformStats } from '../etl/transform.js';
import { FailedRecordsLog } from '../ingest/failedRecords.js';
import { createRunId, publicSettings, runIngestion } from '../ingest/pipeline.js';
import type { IngestionConfig, IngestionEvent, IngestionSettings, RunSummary } from '../ingest/types.js';
import { buildRunReport } from '../reporting/runReport.js';
import { errorMessage } from '../shared/async.js';
import { writeJsonAtomic } from '../shared/fs.js';
import type { Logger } from '../shared/logger.js';

export type ConsoleRunStatus = 'running' | RunSummary['status'];

export interface ConsoleRun {
  id: string;
  status: ConsoleRunStatus;
  createdAt: string;
  fileName: string;
  target: 'mock' | 'custom';
  apiUrl: string;
  settings: IngestionSettings;
  transformStats: TransformStats;
  summary: RunSummary | null;
  events: IngestionEvent[];
  failedRecords: FailedRecordsLog;
  outputDir: string;
}

export type RunView = Omit<ConsoleRun, 'events' | 'failedRecords'> & {
  failedRecordCount: number;
  eventCount: number;
};

type Listener = (event: IngestionEvent) => void;

const MAX_RETAINED_RUNS = 25;

/**
 * Runs ingestion jobs for the console: keeps each run's event history (so a
 * late or reconnecting browser can replay it), fans live events out to
 * subscribers, and writes failed_records.json + run_report.json per run.
 */
export class RunManager {
  private readonly runs = new Map<string, ConsoleRun>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly outputDir: string;
  private readonly logger: Logger;

  constructor(options: { outputDir: string; logger: Logger }) {
    this.outputDir = options.outputDir;
    this.logger = options.logger;
  }

  activeRun(): ConsoleRun | undefined {
    return [...this.runs.values()].find((run) => run.status === 'running');
  }

  start(input: { transform: TransformResult; fileName: string; config: IngestionConfig; target: 'mock' | 'custom' }): ConsoleRun {
    const id = createRunId();
    const outputDir = join(this.outputDir, 'runs', id);
    const run: ConsoleRun = {
      id,
      status: 'running',
      createdAt: new Date().toISOString(),
      fileName: input.fileName,
      target: input.target,
      apiUrl: input.config.apiUrl,
      settings: publicSettings(input.config),
      transformStats: input.transform.stats,
      summary: null,
      events: [],
      failedRecords: new FailedRecordsLog(join(outputDir, 'failed_records.json')),
      outputDir,
    };
    this.runs.set(id, run);
    this.prune();

    const controller = new AbortController();
    this.controllers.set(id, controller);
    const logger = this.logger.child({ runId: id });
    logger.info('Run started', { records: input.transform.records.length, apiUrl: input.config.apiUrl, target: input.target });

    void runIngestion(input.transform.records, input.config, {
      runId: id,
      signal: controller.signal,
      failedRecords: run.failedRecords,
      onEvent: (event) => {
        run.events.push(event);
        if (event.type === 'run_finished') {
          run.summary = event.summary;
          run.status = event.summary.status;
        }
        for (const listener of this.listeners.get(id) ?? []) listener(event);
      },
    })
      .then(async (summary) => {
        logger.info('Run finished', {
          status: summary.status,
          loaded: summary.records.loaded,
          failed: summary.records.failed,
          durationMs: summary.durationMs,
        });
        await writeJsonAtomic(
          join(outputDir, 'run_report.json'),
          buildRunReport({ sourceFile: input.fileName, transform: input.transform, summary }),
        );
      })
      .catch((error: unknown) => logger.error('Could not write the run report', { error: errorMessage(error) }))
      .finally(() => {
        this.controllers.delete(id);
        this.listeners.delete(id);
      });

    return run;
  }

  get(id: string): ConsoleRun | undefined {
    return this.runs.get(id);
  }

  list(): RunView[] {
    return [...this.runs.values()].reverse().map((run) => this.view(run));
  }

  view(run: ConsoleRun): RunView {
    const { events, failedRecords, ...rest } = run;
    return { ...rest, failedRecordCount: failedRecords.entries.length, eventCount: events.length };
  }

  /** Registers a live listener; returns the unsubscribe function. */
  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
    };
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  private prune(): void {
    const finished = [...this.runs.values()].filter((run) => run.status !== 'running');
    const excess = this.runs.size - MAX_RETAINED_RUNS;
    for (const run of finished.slice(0, Math.max(0, excess))) this.runs.delete(run.id);
  }
}
