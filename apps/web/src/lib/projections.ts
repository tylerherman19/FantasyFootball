import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyAvailability, asPlayerId, scoreStatLine, type PlayerId, type Position } from '@ffe/core';
import type { PlayerProjection, ProjectionPool } from '@ffe/core';
import { ARTIFACT_TTL_MS, memoize } from './cache';

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

const ARTIFACT_DIR = join(process.cwd(), '..', '..', 'model', 'artifacts');

const SKILL: readonly string[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

const readArtifact = async (season: number, week: number): Promise<ProjectionArtifact | null> => {
  try {
    const path = join(ARTIFACT_DIR, `projections-${season}-${String(week).padStart(2, '0')}.json`);
    return JSON.parse(await readFile(path, 'utf8')) as ProjectionArtifact;
  } catch {
    return null;
  }
};

/**
 * The artifact, parsed once per process rather than once per caller.
 *
 * The league, trade and waiver loaders each ask for this independently, so a
 * single page view used to parse the same megabyte of JSON three times before
 * any football was simulated.
 */
export const loadArtifact = memoize(
  readArtifact,
  (season, week) => `${season}-${week}`,
  ARTIFACT_TTL_MS,
  'artifact',
);

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
