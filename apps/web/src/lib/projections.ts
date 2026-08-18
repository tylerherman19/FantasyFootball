import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asPlayerId, scoreStatLine, type PlayerId, type Position } from '@ffe/core';
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

const ARTIFACT_DIR = join(process.cwd(), '..', '..', 'model', 'artifacts');

const SKILL: readonly string[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

export const loadArtifact = async (season: number, week: number): Promise<ProjectionArtifact | null> => {
  try {
    const path = join(ARTIFACT_DIR, `projections-${season}-${String(week).padStart(2, '0')}.json`);
    return JSON.parse(await readFile(path, 'utf8')) as ProjectionArtifact;
  } catch {
    return null;
  }
};

const toProjection = (
  player: ArtifactPlayer,
  rules: Readonly<Record<string, number>>,
): PlayerProjection | null => {
  if (!SKILL.includes(player.position)) return null;
  const position = player.position as Position;

  return {
    playerId: asPlayerId(player.playerId),
    position,
    eligiblePositions: [position],
    // Scored here, under this league's own rules.
    mean: Math.max(0, scoreStatLine(player.stats ?? {}, rules)),
    sd: player.sd,
    gameId: player.gameId === '' ? `bye-${player.playerId}` : player.gameId,
    gameLoading: player.gameLoading,
    active: player.active,
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
): ProjectionPool => {
  const weekly = new Map<PlayerId, PlayerProjection>();

  for (const player of Object.values(artifact.players)) {
    const projection = toProjection(player, rules);
    if (projection !== null) weekly.set(projection.playerId, projection);
  }

  return new Map(weeks.map((week) => [week, weekly]));
};

/** Points for one player under one league's rules, for display. */
export const scoreFor = (
  player: ArtifactPlayer,
  rules: Readonly<Record<string, number>>,
): number => Math.max(0, scoreStatLine(player.stats ?? {}, rules));
