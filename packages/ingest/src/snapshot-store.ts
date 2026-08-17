import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where snapshots go.
 *
 * Postgres is the destination, but the pipeline must not be blocked on it —
 * missing kickoff costs a season of accuracy history that cannot be recovered.
 * So this writes newline-delimited JSON locally and backfills to Postgres once
 * credentials exist. Same rows either way.
 */
export interface ProjectionSnapshot {
  readonly season: number;
  readonly week: number;
  readonly playerId: string;
  readonly source: string;
  readonly sourceVersion: string;
  readonly points: number;
  readonly p10?: number;
  readonly p50?: number;
  readonly p90?: number;
  readonly stddev?: number;
  readonly playProb?: number;
  readonly scoringKey: string;
  readonly capturedAt: string;
  readonly kickoffAt?: string;
}

export interface OddsSnapshot {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly commenceAt: string;
  readonly bookmaker: string;
  readonly total?: number;
  readonly homeSpread?: number;
  readonly homeWinProb?: number;
  readonly capturedAt: string;
}

export interface SnapshotStore {
  writeProjections(rows: readonly ProjectionSnapshot[]): Promise<number>;
  writeOdds(rows: readonly OddsSnapshot[]): Promise<number>;
}

/**
 * Append-only local store. Never rewrites history — a corrected projection is a
 * new row with a later `capturedAt`, so the record of what we believed *at the
 * time* stays intact. That is the whole point.
 */
export class JsonlSnapshotStore implements SnapshotStore {
  constructor(private readonly root: string) {}

  async writeProjections(rows: readonly ProjectionSnapshot[]): Promise<number> {
    if (rows.length === 0) return 0;
    const first = rows[0]!;
    return this.#append(join(this.root, 'projections', `${first.season}-${String(first.week).padStart(2, '0')}.jsonl`), rows);
  }

  async writeOdds(rows: readonly OddsSnapshot[]): Promise<number> {
    if (rows.length === 0) return 0;
    const first = rows[0]!;
    return this.#append(join(this.root, 'odds', `${first.season}-${String(first.week).padStart(2, '0')}.jsonl`), rows);
  }

  async #append(path: string, rows: readonly unknown[]): Promise<number> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return rows.length;
  }

  /** Read back for verification and, later, for backfilling into Postgres. */
  async read<T>(relativePath: string): Promise<T[]> {
    const text = await readFile(join(this.root, relativePath), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  }
}
