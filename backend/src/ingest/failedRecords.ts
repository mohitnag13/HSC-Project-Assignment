import { appendFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeJsonAtomic } from '../shared/fs.js';
import type { FailedRecordEntry } from './types.js';

/**
 * Collects records the SHC API refused, or that could not be delivered.
 *
 * Each addition is appended to a journal next to the output file
 * (failed_records.json.partial.ndjson), so the cost stays linear however many
 * records fail, and nothing is lost if the process dies mid-run. flush()
 * renders the final failed_records.json atomically and removes the journal.
 * Writes are serialised, so they can never interleave.
 */
export class FailedRecordsLog {
  readonly filePath: string | null;
  readonly journalPath: string | null;
  private readonly items: FailedRecordEntry[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  /** @param filePath where to persist; null keeps entries in memory only. */
  constructor(filePath: string | null) {
    this.filePath = filePath;
    this.journalPath = filePath ? `${filePath}.partial.ndjson` : null;
  }

  get entries(): readonly FailedRecordEntry[] {
    return this.items;
  }

  add(entries: readonly FailedRecordEntry[]): Promise<void> {
    this.items.push(...entries);
    const journal = this.journalPath;
    if (!journal || entries.length === 0) return Promise.resolve();
    const lines = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    return this.enqueue(async () => {
      await mkdir(dirname(journal), { recursive: true });
      await appendFile(journal, lines, 'utf8');
    });
  }

  /** Writes the complete failed_records.json (an empty array if nothing failed) and drops the journal. */
  flush(): Promise<void> {
    const path = this.filePath;
    const journal = this.journalPath;
    if (!path || !journal) return Promise.resolve();
    const snapshot = this.items.slice();
    return this.enqueue(async () => {
      await writeJsonAtomic(path, snapshot);
      await rm(journal, { force: true });
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(task);
    this.writeChain = run.catch(() => undefined);
    return run;
  }
}
