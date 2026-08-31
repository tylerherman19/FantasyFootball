import type { OddsSnapshot, ProjectionSnapshot, SnapshotStore } from './snapshot-store.js';

/**
 * Supabase-backed store, over PostgREST.
 *
 * Uses the secret key, so it bypasses RLS — these tables are server-write only
 * and must never be reachable with the publishable key.
 *
 * Projections upsert on the unique key, so re-running the job the same week
 * corrects a row rather than duplicating it. Odds always insert, because the
 * whole point is the movement between captures.
 */
export class PostgrestSnapshotStore implements SnapshotStore {
  readonly #url: string;
  readonly #key: string;

  constructor(url: string, secretKey: string) {
    this.#url = url.replace(/\/$/, '');
    this.#key = secretKey;
  }

  async writeProjections(rows: readonly ProjectionSnapshot[]): Promise<number> {
    return this.#post(
      'projection_snapshots?on_conflict=season,week,player_id,source,source_version,scoring_key',
      rows.map((r) => ({
        season: r.season,
        week: r.week,
        player_id: r.playerId,
        source: r.source,
        source_version: r.sourceVersion,
        points: r.points,
        p10: r.p10 ?? null,
        p50: r.p50 ?? null,
        p90: r.p90 ?? null,
        stddev: r.stddev ?? null,
        play_prob: r.playProb ?? null,
        scoring_key: r.scoringKey,
        captured_at: r.capturedAt,
        kickoff_at: r.kickoffAt ?? null,
      })),
      'resolution=merge-duplicates',
    );
  }

  async writeOdds(rows: readonly OddsSnapshot[]): Promise<number> {
    return this.#post(
      'odds_snapshots',
      rows.map((r) => ({
        season: r.season,
        week: r.week,
        game_id: r.gameId,
        home_team: r.homeTeam,
        away_team: r.awayTeam,
        commence_at: r.commenceAt,
        bookmaker: r.bookmaker,
        total: r.total ?? null,
        home_spread: r.homeSpread ?? null,
        home_win_prob: r.homeWinProb ?? null,
        captured_at: r.capturedAt,
      })),
    );
  }

  async #post(path: string, rows: readonly unknown[], prefer?: string): Promise<number> {
    if (rows.length === 0) return 0;

    // PostgREST rejects very large single payloads; chunk to stay well under it.
    const CHUNK = 500;
    let written = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      const res = await fetch(`${this.#url}/rest/v1/${path}`, {
        method: 'POST',
        headers: {
          apikey: this.#key,
          authorization: `Bearer ${this.#key}`,
          'content-type': 'application/json',
          prefer: ['return=minimal', prefer].filter(Boolean).join(','),
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        throw new Error(`PostgREST ${res.status} writing ${path}: ${(await res.text()).slice(0, 300)}`);
      }
      written += batch.length;
    }

    return written;
  }
}

/** Both destinations. Local JSONL is the durable fallback if Postgres is down. */
export class TeeSnapshotStore implements SnapshotStore {
  constructor(private readonly stores: readonly SnapshotStore[]) {}

  async writeProjections(rows: readonly ProjectionSnapshot[]): Promise<number> {
    const counts = await Promise.all(this.stores.map((s) => s.writeProjections(rows)));
    return Math.max(0, ...counts);
  }

  async writeOdds(rows: readonly OddsSnapshot[]): Promise<number> {
    const counts = await Promise.all(this.stores.map((s) => s.writeOdds(rows)));
    return Math.max(0, ...counts);
  }

}
