export interface VersionCandidate {
  line: number;
  /** Epoch ms of last_modified; null when the timestamp is unusable. */
  lastModifiedMs: number | null;
}

/**
 * Picks the most recently updated version of a patient. Versions without a
 * usable timestamp can never win. Ties on last_modified go to the row that
 * appears later in the file (the export's own order is the best remaining
 * signal of recency). Returns null when no version has a usable timestamp.
 */
export function pickLatestVersion<T extends VersionCandidate>(versions: readonly T[]): T | null {
  let winner: T | null = null;
  for (const version of versions) {
    if (version.lastModifiedMs === null) continue;
    if (
      winner === null ||
      version.lastModifiedMs > (winner.lastModifiedMs ?? -Infinity) ||
      (version.lastModifiedMs === winner.lastModifiedMs && version.line > winner.line)
    ) {
      winner = version;
    }
  }
  return winner;
}
