import { scoreStatLine } from '@ffe/core';

/**
 * What the model used to think, and why it changed its mind (§35, §48).
 *
 * The artifact holds one week and is overwritten in place, so before the
 * canonical store existed this question had no answer — not because the model
 * was weak but because nothing remembered. `player_projections` now keeps every
 * publication, and this reads it back.
 *
 * The distinction that makes it useful: a projection can move because **the
 * player** changed or because **the model** changed, and those are completely
 * different pieces of news. A receiver whose number fell because his target
 * share collapsed is a sell signal; one whose number fell because the shrinkage
 * constants were re-fit is not news about him at all. The store records
 * `model_version` alongside every row precisely so the two can be told apart,
 * and this refuses to attribute a change to a player when the model moved
 * underneath him.
 *
 * Read through PostgREST with the secret key, fail-soft throughout: a page must
 * never fail to render because its history sidebar could not load.
 */

export interface ProjectionChange {
  readonly generatedAt: string;
  readonly previousGeneratedAt: string | null;
  readonly modelVersion: string;
  readonly previousModelVersion: string | null;
  /** True when the model itself changed between the two publications. */
  readonly modelChanged: boolean;
  readonly points: number;
  readonly previousPoints: number | null;
  readonly delta: number | null;
  /** The stat that moved most, and by how much, in its own units. */
  readonly driver: { readonly stat: string; readonly change: number } | null;
}

interface Row {
  readonly season: number;
  readonly week: number;
  readonly model_version: string;
  readonly previous_model_version: string | null;
  readonly model_changed: boolean;
  readonly stats: Record<string, number>;
  readonly previous_stats: Record<string, number> | null;
  readonly generated_at: string;
  readonly previous_generated_at: string | null;
}

/** Stats worth naming as a driver. Internal denominators are not news. */
const READABLE: Readonly<Record<string, string>> = {
  targets: 'targets',
  carries: 'carries',
  attempts: 'pass attempts',
  receptions: 'receptions',
  receiving_yards: 'receiving yards',
  rushing_yards: 'rushing yards',
  passing_yards: 'passing yards',
  receiving_tds: 'receiving TDs',
  rushing_tds: 'rushing TDs',
  passing_tds: 'passing TDs',
};

/**
 * Which underlying stat moved most.
 *
 * Reported in the stat's own units rather than in points, because "his targets
 * fell by 2.4 a game" is a fact about football and "he lost 3.1 points" is a
 * fact about your scoring settings. The first is the one that tells you
 * something.
 */
const driverOf = (
  stats: Record<string, number>,
  previous: Record<string, number> | null,
): { stat: string; change: number } | null => {
  if (previous === null) return null;

  let best: { stat: string; change: number } | null = null;

  for (const [key, label] of Object.entries(READABLE)) {
    const change = (stats[key] ?? 0) - (previous[key] ?? 0);
    // Relative to the stat's own scale, so a half-target move is not buried by
    // a twenty-yard one that means less.
    const scale = Math.max(1, Math.abs(previous[key] ?? 0));
    const magnitude = Math.abs(change) / scale;

    if (Math.abs(change) < 0.05) continue;
    if (best === null || magnitude > Math.abs(best.change) / Math.max(1, Math.abs(previous[best.stat] ?? 0))) {
      best = { stat: label, change };
    }
  }

  return best;
};

export const loadProjectionHistory = async (
  playerUid: string,
  rules: Readonly<Record<string, number>>,
  limit = 8,
): Promise<readonly ProjectionChange[]> => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return [];

  try {
    const query = new URLSearchParams({
      player_uid: `eq.${playerUid}`,
      select:
        'season,week,model_version,previous_model_version,model_changed,stats,previous_stats,generated_at,previous_generated_at',
      order: 'generated_at.desc',
      limit: String(limit),
    });

    const res = await fetch(`${url}/rest/v1/projection_changes?${query}`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const rows = (await res.json()) as Row[];

    return rows.map((row) => {
      const points = Math.max(0, scoreStatLine(row.stats ?? {}, rules));
      const previousPoints =
        row.previous_stats === null ? null : Math.max(0, scoreStatLine(row.previous_stats, rules));

      return {
        generatedAt: row.generated_at,
        previousGeneratedAt: row.previous_generated_at,
        modelVersion: row.model_version,
        previousModelVersion: row.previous_model_version,
        modelChanged: row.model_changed,
        points,
        previousPoints,
        delta: previousPoints === null ? null : points - previousPoints,
        driver: driverOf(row.stats ?? {}, row.previous_stats),
      };
    });
  } catch {
    return [];
  }
};

/** One sentence explaining a move, or null when there is nothing to explain. */
export const explainChange = (change: ProjectionChange): string | null => {
  if (change.delta === null || Math.abs(change.delta) < 0.15) return null;

  const direction = change.delta > 0 ? 'up' : 'down';
  const size = Math.abs(change.delta).toFixed(1);

  /*
   * The model moving is not the player moving.
   *
   * Attributing a re-fit of the shrinkage constants to a receiver's target
   * share would be the product inventing a story about him, which is exactly
   * what storing `model_version` beside every row exists to prevent.
   */
  if (change.modelChanged) {
    return `${size} ${direction}, but the model changed between these two publications (${change.previousModelVersion} → ${change.modelVersion}). That is a different number, not a different player.`;
  }

  if (change.driver === null) {
    return `${size} ${direction} on the same model version, with no single stat moving much — a broad re-estimate rather than one thing changing.`;
  }

  const verb = change.driver.change > 0 ? 'rose' : 'fell';
  return `${size} ${direction}: his projected ${change.driver.stat} ${verb} by ${Math.abs(change.driver.change).toFixed(1)} a game.`;
};
