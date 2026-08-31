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

  /**
   * Read back the projections captured for one week.
   *
   * The accuracy report needs both sources side by side, and the only place
   * both exist is here.
   */
  async readProjections(
    season: number,
    week: number,
  ): Promise<{ playerId: string; source: string; sourceVersion: string; points: number }[]> {
    const out: { playerId: string; source: string; sourceVersion: string; points: number }[] = [];
    const PAGE = 1000;

    for (let offset = 0; ; offset += PAGE) {
      const query =
        `projection_snapshots_valid?season=eq.${season}&week=eq.${week}` +
        `&select=player_id,source,source_version,points&limit=${PAGE}&offset=${offset}` +
        `&order=player_id.asc,source.asc`;

      const res = await fetch(`${this.#url}/rest/v1/${query}`, {
        headers: { apikey: this.#key, authorization: `Bearer ${this.#key}` },
      });
      if (!res.ok) {
        throw new Error(`PostgREST ${res.status} reading projections: ${(await res.text()).slice(0, 200)}`);
      }

      const page = (await res.json()) as {
        player_id: string;
        source: string;
        source_version: string;
        points: string | number;
      }[];

      for (const row of page) {
        out.push({
          playerId: row.player_id,
          source: row.source,
          sourceVersion: row.source_version,
          points: Number(row.points),
        });
      }

      if (page.length < PAGE) return out;
    }
  }

  /**
   * Write the realised points back onto every projection of that player.
   *
   * One PATCH per player rather than per row: the same actual settles every
   * source's row for him at once, which is the point of storing them in one
   * table. Rows for players who did not appear are left null, so "not yet
   * scored" and "played and scored nothing" stay distinguishable.
   */
  async scoreWeek(
    season: number,
    week: number,
    actuals: ReadonlyMap<string, number>,
  ): Promise<number> {
    const scoredAt = new Date().toISOString();
    let written = 0;

    // Bounded concurrency: PostgREST is a database in front of an HTTP server
    // and a thousand simultaneous PATCHes helps neither.
    const entries = [...actuals.entries()];
    const LANES = 8;

    await Promise.all(
      Array.from({ length: LANES }, async (_, lane) => {
        for (let i = lane; i < entries.length; i += LANES) {
          const [playerId, points] = entries[i]!;
          const query =
            `projection_snapshots?season=eq.${season}&week=eq.${week}` +
            `&player_id=eq.${encodeURIComponent(playerId)}`;

          const res = await fetch(`${this.#url}/rest/v1/${query}`, {
            method: 'PATCH',
            headers: {
              apikey: this.#key,
              authorization: `Bearer ${this.#key}`,
              'content-type': 'application/json',
              prefer: 'return=minimal',
            },
            body: JSON.stringify({ actual_points: points, scored_at: scoredAt }),
          });
          if (res.ok) written += 1;
        }
      }),
    );

    return written;
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
