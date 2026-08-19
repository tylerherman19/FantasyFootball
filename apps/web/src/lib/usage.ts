import { scoreStatLine } from '@ffe/core';
import { loadArtifact, type ArtifactPlayer } from './projections';

/**
 * Usage, opportunity and offensive shape — read out of the projection artifact.
 *
 * The model projects *stat lines*, not points: attempts, carries, targets,
 * receptions, yards and touchdowns, per player per week. Until now the app
 * collapsed all of that to a single number the moment it loaded, and threw the
 * rest away. That single number is the least interesting thing in the file.
 *
 * What's actually in there is the story behind the number. Two receivers
 * projected for the same points are not the same asset if one gets there on
 * nine targets and the other on four targets and a touchdown — the first is
 * repeatable and the second is a coin flip. Opportunity is what carries over
 * week to week; efficiency and touchdowns are what regress.
 *
 * So everything here is derived from volume first:
 *
 * - **Opportunity** — carries plus targets. The single best predictor of next
 *   week, and the thing a manager can actually see change.
 * - **Share** — a player's cut of his own NFL team's targets or carries. The
 *   same eight targets means something different on a team that throws 40 times
 *   than on one that throws 25.
 * - **Touchdown dependence** — how much of the projection is scored by the
 *   touchdown terms in *this league's* rules. High dependence means high
 *   variance regardless of how safe the total looks.
 * - **Team shape** — pass rate, play volume and how concentrated the targets
 *   are. This is where a defense's scheme shows up in the numbers we have: a
 *   team facing light boxes runs more, a team behind throws more, and both land
 *   here as a changed pass rate and a changed target distribution.
 *
 * Nothing here re-models anything. It is arithmetic over what Python already
 * exported, which is exactly why it costs nothing to show.
 */

/** Stat keys that only pay out on a touchdown. */
const TD_KEYS: readonly string[] = ['passing_tds', 'rushing_tds', 'receiving_tds', 'def_tds'];

export interface PlayerUsage {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly active: boolean;
  /** The NFL game he appears in, `2026_01_WAS_PHI`. Carries the opponent. */
  readonly gameId: string;

  // Volume
  readonly passAttempts: number;
  readonly carries: number;
  readonly targets: number;
  readonly receptions: number;
  /** Carries plus targets: everything that can become production. */
  readonly opportunities: number;
  /** Carries plus receptions: the ball actually in his hands. */
  readonly touches: number;

  // Yardage
  readonly passingYards: number;
  readonly rushingYards: number;
  readonly receivingYards: number;
  readonly yardsFromScrimmage: number;

  // Scoring
  readonly touchdowns: number;
  /** Points under this league's rules. */
  readonly points: number;
  /** Share of those points that comes from touchdown terms, 0-1. */
  readonly tdDependence: number;
  readonly sd: number;
  /** Points per unit of spread — the risk-adjusted read. */
  readonly pointsPerRisk: number;

  // Rates. Null rather than zero when the denominator is too small to mean it.
  readonly yardsPerTarget: number | null;
  readonly yardsPerCarry: number | null;
  readonly catchRate: number | null;
  readonly pointsPerOpportunity: number | null;

  // Shares of his own NFL offense, 0-1.
  readonly targetShare: number;
  readonly carryShare: number;
}

/**
 * The shape of one NFL offense, as the model projects it.
 *
 * One caveat that has to travel with these numbers, because it changes how they
 * should be read: the totals are the sum of *every* projected player on the
 * team, including backups who probably will not play. A team's projected
 * attempts therefore run well above what a real game produces — this is a
 * distribution over who *would* get the work, not a forecast of a box score.
 *
 * Ratios survive that intact and counts do not, so everything exposed here is a
 * ratio or a share. Pass lean, concentration and each player's cut of his own
 * offense are all comparable across teams; the raw volume is carried only as
 * the denominator behind them, and the UI labels it for what it is.
 */
export interface TeamOffense {
  readonly team: string;
  readonly passAttempts: number;
  readonly carries: number;
  readonly plays: number;
  /** Dropbacks as a share of plays — the clearest single read on identity. */
  readonly passRate: number;
  readonly passingYards: number;
  readonly rushingYards: number;
  readonly totalYards: number;
  readonly projectedPoints: number;
  /**
   * Herfindahl index over target share, 0-1.
   *
   * How concentrated the passing game is. Near 1 means one receiver eats;
   * near 0 means it's spread around. Concentration is good for the player who
   * has it and bad for everyone rostering his teammates.
   */
  readonly targetConcentration: number;
  /** The single biggest target share on the team. */
  readonly topTargetShare: number;
  readonly topTargetName: string | null;
}

const stat = (player: ArtifactPlayer, key: string): number => player.stats?.[key] ?? 0;

/**
 * Points a stat line scores from touchdowns alone, under one league's rules.
 *
 * Scored through the same function as everything else rather than by looking up
 * a per-TD constant, because leagues differ — six points, four points, bonus
 * yardage tiers — and a hardcoded 6 would quietly mis-state the split.
 */
const touchdownPoints = (player: ArtifactPlayer, rules: Readonly<Record<string, number>>): number => {
  const onlyTds: Record<string, number> = {};
  for (const key of TD_KEYS) {
    const value = player.stats?.[key];
    if (value !== undefined) onlyTds[key] = value;
  }
  return scoreStatLine(onlyTds, rules);
};

const rate = (numerator: number, denominator: number, floor: number): number | null =>
  denominator >= floor ? numerator / denominator : null;

/**
 * Usage for every projected player, plus the offensive shape of each NFL team.
 *
 * Computed together because shares are only meaningful relative to a team
 * total, and the totals come from the same pass.
 */
export const buildUsage = async (
  season: number,
  week: number,
  rules: Readonly<Record<string, number>>,
): Promise<{ players: PlayerUsage[]; offenses: TeamOffense[] }> => {
  const artifact = await loadArtifact(season, week);
  if (artifact === null) return { players: [], offenses: [] };

  const all = Object.values(artifact.players);

  // Team totals first: a share needs a denominator.
  const totals = new Map<string, { targets: number; carries: number; attempts: number }>();
  for (const player of all) {
    if (player.team === '') continue;
    const bucket = totals.get(player.team) ?? { targets: 0, carries: 0, attempts: 0 };
    bucket.targets += stat(player, 'targets');
    bucket.carries += stat(player, 'carries');
    bucket.attempts += stat(player, 'attempts');
    totals.set(player.team, bucket);
  }

  const players: PlayerUsage[] = all.map((player) => {
    const carries = stat(player, 'carries');
    const targets = stat(player, 'targets');
    const receptions = stat(player, 'receptions');
    const passAttempts = stat(player, 'attempts');

    const passingYards = stat(player, 'passing_yards');
    const rushingYards = stat(player, 'rushing_yards');
    const receivingYards = stat(player, 'receiving_yards');

    const touchdowns =
      stat(player, 'passing_tds') + stat(player, 'rushing_tds') + stat(player, 'receiving_tds');

    const points = Math.max(0, scoreStatLine(player.stats ?? {}, rules));
    const fromTds = touchdownPoints(player, rules);
    const opportunities = carries + targets;

    return {
      playerId: player.playerId,
      name: player.name,
      position: player.position,
      team: player.team,
      active: player.active,
      gameId: player.gameId,

      passAttempts,
      carries,
      targets,
      receptions,
      opportunities,
      touches: carries + receptions,

      passingYards,
      rushingYards,
      receivingYards,
      yardsFromScrimmage: rushingYards + receivingYards,

      touchdowns,
      points,
      tdDependence: points > 0 ? Math.max(0, Math.min(1, fromTds / points)) : 0,
      sd: player.sd,
      pointsPerRisk: player.sd > 0 ? points / player.sd : 0,

      // Floors keep a rounding artefact from turning into a 40-yard average.
      yardsPerTarget: rate(receivingYards, targets, 1),
      yardsPerCarry: rate(rushingYards, carries, 1),
      catchRate: rate(receptions, targets, 1),
      pointsPerOpportunity: rate(points, opportunities, 2),

      targetShare: targets / Math.max(totals.get(player.team)?.targets ?? 0, 1e-9),
      carryShare: carries / Math.max(totals.get(player.team)?.carries ?? 0, 1e-9),
    };
  });

  const byTeam = new Map<string, PlayerUsage[]>();
  for (const player of players) {
    if (player.team === '') continue;
    const bucket = byTeam.get(player.team);
    if (bucket === undefined) byTeam.set(player.team, [player]);
    else bucket.push(player);
  }

  const offenses: TeamOffense[] = [...byTeam.entries()]
    .map(([team, roster]) => {
      const passAttempts = roster.reduce((sum, p) => sum + p.passAttempts, 0);
      const carries = roster.reduce((sum, p) => sum + p.carries, 0);
      const plays = passAttempts + carries;

      const receivers = roster.filter((p) => p.targets > 0);
      const concentration = receivers.reduce((sum, p) => sum + p.targetShare ** 2, 0);
      const top = receivers.reduce<PlayerUsage | null>(
        (best, p) => (best === null || p.targetShare > best.targetShare ? p : best),
        null,
      );

      return {
        team,
        passAttempts,
        carries,
        plays,
        passRate: plays > 0 ? passAttempts / plays : 0,
        passingYards: roster.reduce((sum, p) => sum + p.passingYards, 0),
        rushingYards: roster.reduce((sum, p) => sum + p.rushingYards, 0),
        totalYards: roster.reduce((sum, p) => sum + p.passingYards + p.rushingYards, 0),
        projectedPoints: roster.reduce((sum, p) => sum + p.points, 0),
        targetConcentration: Math.max(0, Math.min(1, concentration)),
        topTargetShare: top?.targetShare ?? 0,
        topTargetName: top?.name ?? null,
      };
    })
    // Real NFL offenses only. "FA" is the artifact's holding pen for unsigned
    // players — it has more projected carries than any actual team and no
    // offense at all, so leaving it in puts a phantom 33rd team at the top of
    // every volume chart.
    .filter((offense) => offense.team !== 'FA' && offense.plays > 10)
    .sort((a, b) => b.plays - a.plays);

  return { players, offenses };
};

/**
 * Points a replacement-level starter provides at each position.
 *
 * Defined as the player who would be starting if you had nobody — the
 * `teamCount * startersPerTeam + 1`-ranked player at that position. Everything
 * above that line is what a roster spot is actually worth, which is why a QB1
 * in a one-quarterback league is worth so much less than his point total looks.
 */
export const replacementLevel = (
  players: readonly PlayerUsage[],
  position: string,
  startersInLeague: number,
): number => {
  const ranked = players
    .filter((player) => player.position === position && player.active)
    .map((player) => player.points)
    .sort((a, b) => b - a);

  if (ranked.length === 0) return 0;
  return ranked[Math.min(ranked.length - 1, Math.max(0, startersInLeague))] ?? 0;
};

/** The scoring curve at one position, for showing how fast the drop-off is. */
export const positionCurve = (
  players: readonly PlayerUsage[],
  position: string,
  depth = 36,
): number[] =>
  players
    .filter((player) => player.position === position && player.active)
    .map((player) => player.points)
    .sort((a, b) => b - a)
    .slice(0, depth);
