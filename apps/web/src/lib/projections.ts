import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyAvailability, asPlayerId, playProbability, predictionQuantiles, productionWhenPlaying, scoreStatLine, type PlayerId, type Position } from '@ffe/core';
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
  readonly p25?: number;
  readonly p50?: number;
  readonly p75?: number;
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
  readonly depthRank?: number | null;
  readonly contingencyStats?: Readonly<Record<string, number>>;
  readonly contingencySd?: number;
  /**
   * Where the projection came from. `rookie-prior` is a draft-capital estimate
   * for a player who has never taken an NFL snap, and the UI should say so
   * rather than presenting it identically to a number built from real games.
   */
  readonly basis?: 'history' | 'rookie-prior';
  readonly scenario?: {
    readonly playProbability: number;
    readonly teamPlays: number;
    readonly passRate: number;
    readonly redZoneRate: number;
    readonly environmentMultiplier?: number;
    readonly schemeVolumeMultiplier?: number;
    readonly schemeEfficiencyMultiplier?: number;
    readonly role?: string;
  };
  /**
   * The model's own decomposition, attached only where it has been loaded.
   *
   * Lives in a *separate* artifact and is merged in by `loadExplanation` on the
   * one page that asks for it. It is a third of the payload and every other
   * page — roster, lineup, trades, waivers — would otherwise carry half a
   * megabyte it never opens.
   */
  readonly why?: PlayerExplanation;
}

/**
 * Why a projection is what it is, as stat lines rather than points.
 *
 * `prior` is every stat at its positional average; `opportunity` is his volume
 * with the positional rates. Scored per league at serve time, the two gaps are
 * what his usage and his efficiency are each worth. Absent for anyone the usage
 * model did not build — rookies, kickers, IDP, team defenses.
 */
export interface PlayerExplanation {
  readonly prior?: Readonly<Record<string, number>>;
  readonly baseOpportunity?: Readonly<Record<string, number>>;
  readonly opportunity?: Readonly<Record<string, number>>;
  readonly observed?: Readonly<Record<string, number>>;
  readonly effectiveGames: number;
  readonly scheme?: {
    readonly team?: string;
    readonly paceMultiplier?: number;
    readonly passShape?: number;
    readonly runShape?: number;
  };
}

interface ExplanationArtifact {
  readonly modelVersion: string;
  readonly generatedAt: string;
  readonly why: Record<string, PlayerExplanation>;
}

const explanations = new Map<string, ExplanationArtifact | null>();

/**
 * The decomposition for one player, loaded on demand.
 *
 * Separate from `loadArtifact` on purpose: only the player page needs this, and
 * making every other route pay for it was a self-inflicted regression from
 * shipping explainability inside the main artifact.
 */
export const loadExplanation = async (
  season: number,
  week: number,
  playerId: string,
): Promise<PlayerExplanation | undefined> => {
  const key = `${season}-${String(week).padStart(2, '0')}`;

  let artifact = explanations.get(key);
  if (artifact === undefined) {
    artifact = null;
    const raw = await readArtifactFile(`explanations-${key}.json`);
    if (raw !== null) {
      try {
        artifact = JSON.parse(raw) as ExplanationArtifact;
      } catch {
        artifact = null;
      }
    }
    explanations.set(key, artifact);
  }

  return artifact?.why[playerId];
};

export interface ProjectionArtifact {
  readonly modelVersion: string;
  readonly season: number;
  readonly week: number;
  readonly generatedAt: string;
  readonly playerCount: number;
  readonly players: Record<string, ArtifactPlayer>;
  /** NFL game identity by week and team, so future-week correlations are real. */
  readonly teamGameIdsByWeek?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
  useContingency = false,
  externalRoleProbability = 1,
  gameIdOverride?: string,
  clearedFrom: string | null = null,
): PlayerProjection | null => {
  if (!SKILL.includes(player.position)) return null;
  const position = player.position as Position;

  const sourceStats = useContingency ? (player.contingencyStats ?? player.stats) : player.stats;
  const sourceSd = useContingency ? (player.contingencySd ?? player.sd) : player.sd;
  const scored = Math.max(0, scoreStatLine(sourceStats ?? {}, rules));

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
  const adjusted = applyAvailability(scored, sourceSd, injuryStatus, onBye, clearedFrom);
  const roleProbability = Math.min(1, Math.max(0, player.scenario?.playProbability ?? 1)) * externalRoleProbability;
  const mean = adjusted.mean * roleProbability;
  const variance =
    roleProbability * (adjusted.sd * adjusted.sd + adjusted.mean * adjusted.mean) - mean * mean;
  const scenarioStats = Object.fromEntries(
    Object.entries(sourceStats ?? {}).map(([stat, value]) => [
      stat,
      value * productionWhenPlaying(injuryStatus),
    ]),
  );

  const quantiles = predictionQuantiles(mean, Math.sqrt(Math.max(variance, 0)));
  return {
    playerId: asPlayerId(player.playerId),
    position,
    eligiblePositions: [position],
    mean,
    sd: Math.sqrt(Math.max(variance, 0)),
    ...quantiles,
    // A player on bye shares no game with his team-mates, so he must not be
    // drawn from their correlated game outcome.
    gameId:
      onBye
        ? `bye-${player.playerId}`
        : gameIdOverride ?? (player.gameId === '' ? `unknown-${player.playerId}` : player.gameId),
    gameLoading: player.gameLoading,
    // A ruled-out player must never reach the lineup solver.
    active: (player.active || useContingency) && adjusted.playProbability * roleProbability > 0,
    scenario: {
      stats: scenarioStats,
      rules,
      playProbability: adjusted.playProbability * roleProbability,
      teamPlays: player.scenario?.teamPlays ?? 64,
      passRate: player.scenario?.passRate ?? 0.58,
      redZoneRate: player.scenario?.redZoneRate ?? 0.2,
      ...(player.scenario?.environmentMultiplier !== undefined
        ? { environmentMultiplier: player.scenario.environmentMultiplier }
        : {}),
      ...(player.scenario?.schemeVolumeMultiplier !== undefined
        ? { schemeVolumeMultiplier: player.scenario.schemeVolumeMultiplier }
        : {}),
      ...(player.scenario?.schemeEfficiencyMultiplier !== undefined
        ? { schemeEfficiencyMultiplier: player.scenario.schemeEfficiencyMultiplier }
        : {}),
    },
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
  availability: Record<string, { injuryStatus: string | null; clearedFrom?: string | null }> = {},
): ProjectionPool => {
  const [first] = weeks;
  const players = Object.values(artifact.players);
  const pool = new Map<number, Map<PlayerId, PlayerProjection>>();

  const qbsByTeam = new Map<string, ArtifactPlayer[]>();
  for (const player of players) {
    if (player.position !== 'QB' || player.team === '' || player.team === 'FA') continue;
    const list = qbsByTeam.get(player.team) ?? [];
    list.push(player);
    qbsByTeam.set(player.team, list);
  }
  const contingencyQbByTeam = new Map<string, ArtifactPlayer>();
  for (const [team, qbs] of qbsByTeam) {
    const backup = qbs
      .filter((player) => player.contingencyStats !== undefined)
      .sort((a, b) => (a.depthRank ?? 99) - (b.depthRank ?? 99))[0];
    if (backup !== undefined) contingencyQbByTeam.set(team, backup);
  }
  const primaryFor = (team: string): ArtifactPlayer | undefined =>
    qbsByTeam.get(team)?.find((candidate) => candidate.active && (candidate.depthRank === 1 || candidate.depthRank == null));

  for (const week of weeks) {
    const forWeek = new Map<PlayerId, PlayerProjection>();
    const games = artifact.teamGameIdsByWeek?.[String(week)];

    for (const player of players) {
      // Current injury reports are not carried into future weeks.
      const status = week === first ? availability[player.playerId]?.injuryStatus ?? null : null;
      // Nor is a clearance: it is a fact about this Sunday's inactives list.
      const clearedFrom = week === first ? availability[player.playerId]?.clearedFrom ?? null : null;
      const primary = player.position === 'QB' && player.contingencyStats !== undefined
        ? primaryFor(player.team)
        : undefined;
      const roleProbability = primary === undefined
        ? 1
        : week === first
          ? 1 - playProbability(availability[primary.playerId]?.injuryStatus ?? null)
          : 0;
      const useContingency = player.contingencyStats !== undefined &&
        contingencyQbByTeam.get(player.team)?.playerId === player.playerId &&
        roleProbability > 0;
      const gameId =
        games?.[player.team] ??
        (week === artifact.week && player.gameId !== ''
          ? player.gameId
          : `week-${week}-${player.team || player.playerId}`);
      const projection = toProjection(
        player,
        rules,
        status,
        week,
        useContingency,
        player.contingencyStats === undefined ? 1 : roleProbability,
        gameId,
        clearedFrom,
      );
      if (projection !== null) forWeek.set(projection.playerId, projection);
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
  clearedFrom: string | null = null,
): number => {
  const scored = Math.max(0, scoreStatLine(player.stats ?? {}, rules));
  const onBye = week !== null && player.byeWeek === week;
  if (injuryStatus === null && clearedFrom === null && !onBye) return scored;
  return applyAvailability(scored, player.sd, injuryStatus, onBye, clearedFrom).mean;
};
