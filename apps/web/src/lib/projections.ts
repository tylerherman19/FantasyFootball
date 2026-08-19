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
  readonly active: boolean;
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
): PlayerProjection | null => {
  if (!SKILL.includes(player.position)) return null;
  const position = player.position as Position;

  const scored = Math.max(0, scoreStatLine(player.stats ?? {}, rules));
  const onBye = !player.active;

  // Availability is applied here rather than in the model, because injuries
  // change daily and the artifact is rebuilt weekly.
  const adjusted = applyAvailability(scored, player.sd, injuryStatus, onBye);

  return {
    playerId: asPlayerId(player.playerId),
    position,
    eligiblePositions: [position],
    mean: adjusted.mean,
    sd: adjusted.sd,
    gameId: player.gameId === '' ? `bye-${player.playerId}` : player.gameId,
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
 */
export const buildPool = (
  artifact: ProjectionArtifact,
  weeks: readonly number[],
  rules: Readonly<Record<string, number>>,
  availability: Record<string, { injuryStatus: string | null }> = {},
): ProjectionPool => {
  const currentWeek = new Map<PlayerId, PlayerProjection>();
  const laterWeeks = new Map<PlayerId, PlayerProjection>();

  for (const player of Object.values(artifact.players)) {
    const status = availability[player.playerId]?.injuryStatus ?? null;

    const now = toProjection(player, rules, status);
    if (now !== null) currentWeek.set(now.playerId, now);

    // Injuries are applied to this week only. A player out on Sunday is
    // usually back later in the season, and carrying today's designation
    // across fourteen weeks would write off half the league by November.
    const later = toProjection(player, rules, null);
    if (later !== null) laterWeeks.set(later.playerId, later);
  }

  const [first, ...rest] = weeks;

  return new Map([
    ...(first === undefined ? [] : ([[first, currentWeek]] as [number, typeof currentWeek][])),
    ...rest.map((week) => [week, laterWeeks] as [number, typeof laterWeeks]),
  ]);
};

/** Points for one player under one league's rules, for display. */
export const scoreFor = (
  player: ArtifactPlayer,
  rules: Readonly<Record<string, number>>,
  injuryStatus: string | null = null,
): number => {
  const scored = Math.max(0, scoreStatLine(player.stats ?? {}, rules));
  if (injuryStatus === null) return scored;
  return applyAvailability(scored, player.sd, injuryStatus, !player.active).mean;
};
