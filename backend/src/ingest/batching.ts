import type { PatientRecord } from '../domain/patient.js';
import type { Batch } from './types.js';

/** Splits records into batches of at most `size`, with stable, sortable IDs (B001, B002, ...). */
export function createBatches(records: readonly PatientRecord[], size: number): Batch[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('batch size must be a positive integer');
  const count = Math.ceil(records.length / size);
  const width = Math.max(3, String(count).length);
  return Array.from({ length: count }, (_, index) => ({
    id: `B${String(index + 1).padStart(width, '0')}`,
    records: records.slice(index * size, (index + 1) * size),
  }));
}

/** Halves a batch; children are named <parent>.1 and <parent>.2. */
export function bisectBatch(batch: Batch): [Batch, Batch] {
  const middle = Math.ceil(batch.records.length / 2);
  return [
    { id: `${batch.id}.1`, records: batch.records.slice(0, middle) },
    { id: `${batch.id}.2`, records: batch.records.slice(middle) },
  ];
}
