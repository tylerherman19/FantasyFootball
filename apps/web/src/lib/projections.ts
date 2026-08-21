import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyAvailability, asPlayerId, scoreStatLine, type PlayerId, type Position } from '@ffe/core';
import type { PlayerProjection, ProjectionPool } from '@ffe/core';

/**
 * Load the projection artifact the model exports.
 *
 * The app never computes projections — it serves what Python produced, which is
 * what keeps results reproducible and the runtime cheap.
 */

export interface ArtifactPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  /** Projected stat line. Points are derived per league, never baked in. */
  readonly stats: Readonly<Record<string, number>>;
  readonly sd: number;
  readonly gameId: string;
  readonly gameLoading: number;
  /**
   * The week this player's team does not play, for the whole season.
   *
   * `null` means no bye is known — a free agent, or a team missing from the
   * schedule. It must never be read as "bye in week 0".
   */
  readonly byeWeek: number | null;
  /** True when the player is on an NFL roster. Not a statement about any week. */
  readonly active: boolean;
  /**
   * Where the projection came from. `rookie-prior` is a draft-capital estimate
   * for a player who has never taken an NFL snap, and the UI should say so
   * rather than presenting it identically to a number built from real games.
   */
  readonly basis?: 'history' | 'rookie-prior';
}

export interface ProjectionArtifact {
  readonly modelVersion: string;
  readonly season: number;
  readonly week: number;
  readonly generatedAt: string;
  readonly playerCount: number;
  readonly players: Record<string, ArtifactPlayer>;
}

/**
 * Where the artifacts live, depending on who is asking.
 *
 * The Next server runs from `apps/web`, a script run with npm from the repo
 * root, and a serverless bundle from wherever the platform unpacked it. Trying
 * each in turn costs one failed `open` and removes a whole class of "renders
 * empty in production and fine locally" bug.
 */
/*
 * `turbopackIgnore` on the joins below: the bundler cannot see through a
 * runtime-built path, so it conservatively traces the entire repository into
 * the deployment — every source file and the whole public folder — which blows
 * up bundle size for no benefit. What actually needs shipping is declared
 * explicitly by `outputFileTracingIncludes` in next.config.ts, so the automatic
 * tracing is redundant here rather than load-bearing.
 */
const ARTIFACT_DIRS = [
  join(/* turbopackIgnore: true */ process.cwd(), '..', '..', 'model', 'artifacts'),
  join(/* turbopackIgnore: true */ process.cwd(), 'model', 'artifacts'),
];

const readArtifactFile = async (filename: string): Promise<string | null> => {
  for (const dir of ARTIFACT_DIRS) {
    try {
      return await readFile(join(dir, filename), 'utf8');
    } catch {
      continue;
    }
  }
  return null;
};

export { readArtifactFile };

const SKILL: readonly string[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

/**
 * Held for the life of the process once read.
 *
 * The artifact is a few megabytes of JSON and is rewritten weekly by a batch
 * job, never in place — so re-reading and re-parsing it on every call, which is
 * several times per page across projections, players and roster analysis, was
 * pure repetition. A `null` result is cached too: a missing artifact stays
 * missing until a deploy, and retrying the same failed open on every render
 * gains nothing.
 */
const artifacts = new Map<string, ProjectionArtifact | null>();

export const loadArtifact = async (season: number, week: number): Promise<ProjectionArtifact | null> => {
  const key = `${season}-${String(week).padStart(2, '0')}`;

  const cached = artifacts.get(key);
  if (cached !== undefined) return cached;

  let artifact: ProjectionArtifact | null = null;
  const raw = await readArtifactFile(`projections-${key}.json`);
  if (raw !== null) {
    try {
      artifact = JSON.parse(raw) as ProjectionArtifact;
    } catch {
      artifact = null;
    }
  }

  artifacts.set(key, artifact);
  return artifact;
};

const toProjection = (
  player: ArtifactPlayer,
  rules: Readonly<Record<string, number>>,
  injuryStatus: string | null = null,
  week: number | null = null,
): PlayerProjection | null => {
  if (!SKILL.includes(player.position)) return null;
  const position = player.position as Position;

  const scored = Math.max(0, scoreStatLine(player.stats ?? {}, rules));

  /*
   * A bye belongs to a week, not to a player.
   *
   * This used to read `!player.active`, where `active` meant "his team had a
   * game in the one week the artifact was exported for". Because the pool
   * reuses that week's projection for every remaining week, both directions
   * were wrong: a player whose bye fell in the exported week was zeroed for the
   * entire rest of the season, and everyone else was simulated as playing all
   * fourteen — so once every fourteen weeks the lineup board recommended
   * starting someone who was not playing.
   */
  const onBye = week !== null && player.byeWeek === week;

  // Availability is applied here rather than in the model, because injuries
  // change daily and the artifact is rebuilt weekly.
  const adjusted = applyAvailability(scored, player.sd, injuryStatus, onBye);

  return {
    playerId: asPlayerId(player.playerId),
    position,
    eligiblePositions: [position],
    mean: adjusted.mean,
    sd: adjusted.sd,
    // A player on bye shares no game with his team-mates, so he must not be
    // drawn from their correlated game outcome.
    gameId: onBye || player.gameId === '' ? `bye-${player.playerId}` : player.gameId,
    gameLoading: player.gameLoading,
    // A ruled-out player must never reach the lineup solver.
    active: player.active && adjusted.playProbability > 0,
  };
};

/**
 * Build a pool covering every remaining week.
 *
 * We currently export one week at a time, so future weeks reuse the latest
 * projection. That is honest for a rest-of-season simulation — the alternative,
 * decaying toward the mean, would understate good players without evidence —
 * and it is replaced by per-week exports once the season is running.
 *
 * Form is reused across weeks; *availability* is not. A player's expected
 * production next month is best estimated by what we think of him now, but his
 * bye is a fact about the calendar, so each week gets its own answer to "is he
 * playing at all".
 */
export const buildPool = (
  artifact: ProjectionArtifact,
  weeks: readonly number[],
  rules: Readonly<Record<string, number>>,
  availability: Record<string, { injuryStatus: string | null }> = {},
): ProjectionPool => {
  const [first, ...rest] = weeks;
  const players = Object.values(artifact.players);

  const currentWeek = new Map<PlayerId, PlayerProjection>();
  // The shared baseline for future weeks: no injury designation, not on bye.
  const baseline = new Map<PlayerId, PlayerProjection>();
  // Only the players whose bye falls in a given week differ from that baseline,
  // so each future week is a small overlay rather than its own full copy of
  // several thousand players.
  const byeByWeek = new Map<number, PlayerId[]>();
  const onBye = new Map<PlayerId, PlayerProjection>();

  for (const player of players) {
    const status = availability[player.playerId]?.injuryStatus ?? null;

    if (first !== undefined) {
      const now = toProjection(player, rules, status, first);
      if (now !== null) currentWeek.set(now.playerId, now);
    }

    // Injuries are applied to this week only. A player out on Sunday is
    // usually back later in the season, and carrying today's designation
    // across fourteen weeks would write off half the league by November.
    const later = toProjection(player, rules, null, null);
    if (later === null) continue;
    baseline.set(later.playerId, later);

    const bye = player.byeWeek;
    if (bye === null || bye === undefined) continue;

    const sitting = toProjection(player, rules, null, bye);
    if (sitting === null) continue;
    onBye.set(sitting.playerId, sitting);

    const existing = byeByWeek.get(bye);
    if (existing === undefined) byeByWeek.set(bye, [sitting.playerId]);
    else existing.push(sitting.playerId);
  }

  const pool = new Map<number, Map<PlayerId, PlayerProjection>>();
  if (first !== undefined) pool.set(first, currentWeek);

  for (const week of rest) {
    const sittingThisWeek = byeByWeek.get(week);
    if (sittingThisWeek === undefined) {
      pool.set(week, baseline);
      continue;
    }

    const forWeek = new Map(baseline);
    for (const playerId of sittingThisWeek) {
      const sitting = onBye.get(playerId);
      if (sitting !== undefined) forWeek.set(playerId, sitting);
    }
    pool.set(week, forWeek);
  }

  return pool;
};

/**
 * The most recent artifact for a season, whatever week it was exported for.
 *
 * Callers that already know the week should use `loadArtifact`. This exists for
 * the freshness report, which has to answer "how old is the model output?"
 * without first knowing which week the model last ran for — and answering that
 * by assuming week 1 is how a status page ends up confidently reporting on an
 * artifact that was superseded in September.
 *
 * Searches downward so the newest week is found first; a miss costs one failed
 * open and is memoized by `loadArtifact`.
 */
export const loadLatestArtifact = async (
  season: number,
  maxWeek = 18,
): Promise<ProjectionArtifact | null> => {
  for (let week = maxWeek; week >= 1; week -= 1) {
    const artifact = await loadArtifact(season, week);
    if (artifact !== null) return artifact;
  }
  return null;
};

/**
 * Is this player's team on its bye in `week`?
 *
 * `byeWeek` is null for free agents and for teams missing from the schedule.
 * That means "no bye known" and must never match a real week — in particular it
 * must not be read as week 0.
 */
export const isOnBye = (player: ArtifactPlayer, week: number | null): boolean =>
  week !== null && player.byeWeek !== null && player.byeWeek === week;

/**
 * Is this player available to start in `week`?
 *
 * Kept distinct from `ArtifactPlayer.active`, which means only "on an NFL
 * roster". The two were the same field until byes moved out of the artifact,
 * and conflating them is what put players on bye into the lineup board. Call
 * sites that mean "playing this week" should say so.
 */
export const isPlayingIn = (player: ArtifactPlayer, week: number | null): boolean =>
  player.active && !isOnBye(player, week);

/** Points for one player under one league's rules, for display. */
export const scoreFor = (
  player: ArtifactPlayer,
  rules: Readonly<Record<string, number>>,
  injuryStatus: string | null = null,
  week: number | null = null,
): number => {
  const scored = Math.max(0, scoreStatLine(player.stats ?? {}, rules));
  const onBye = week !== null && player.byeWeek === week;
  if (injuryStatus === null && !onBye) return scored;
  return applyAvailability(scored, player.sd, injuryStatus, onBye).mean;
};
