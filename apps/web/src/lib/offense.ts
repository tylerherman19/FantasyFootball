import { readArtifactFile } from './projections';

/**
 * What each offence does, and therefore how much there is to go round.
 *
 * Player usage is downstream of team behaviour, and the team layer was computed
 * but never served: `model/features/team_context.py` has produced pace and PROE
 * since Phase 4b, and the only thing that ever read them was the matchup model
 * that got measured and declined. So the numbers were correct and invisible.
 *
 * Three quantities carry most of it:
 *
 * - **Plays per game** — the volume everything else divides up. Fantasy points
 *   are bounded by snaps, and snaps vary between teams far more than most
 *   projections admit.
 * - **PROE** — pass rate over expected. Raw pass rate is mostly a record of
 *   game script, because teams that trail throw; subtracting the league rate
 *   *for the same down, distance and score* leaves the part that is identity
 *   rather than circumstance, and identity is the part that persists.
 * - **Red-zone pass rate** — who gets the ball where touchdowns are scored,
 *   which is the noisiest and most valuable slice of a fantasy week.
 */

export interface TeamOffense {
  readonly team: string;
  readonly season: number;
  readonly playsPerGame: number;
  readonly playsPerGamePct: number | null;
  readonly secondsPerPlay: number;
  readonly pacePct: number | null;
  readonly passRate: number;
  readonly proe: number;
  readonly proePct: number | null;
  readonly neutralPassRate: number;
  readonly redZonePlays?: number;
  readonly redZonePassRate?: number;
  readonly redZoneTds?: number;
  readonly goalLinePlays?: number;
  readonly goalLinePassRate?: number | null;
}

export interface OffenseArtifact {
  readonly generatedAt: string;
  readonly season: number;
  readonly note: string;
  readonly teams: Readonly<Record<string, TeamOffense>>;
}

let cache: OffenseArtifact | null | undefined;

export const loadOffense = async (): Promise<OffenseArtifact | null> => {
  if (cache !== undefined) return cache;
  try {
    const raw = await readArtifactFile('team-offense.json');
    cache = raw === null ? null : (JSON.parse(raw) as OffenseArtifact);
  } catch {
    cache = null;
  }
  return cache;
};

/** Ordinal out of 32, counting from the end the label implies. */
export const rankOf = (percentile: number | null): number | null =>
  percentile === null ? null : Math.max(1, Math.round((1 - percentile) * 31) + 1);

/**
 * One sentence on what this offence means for the players in it.
 *
 * Derived from the numbers rather than written about them — the thresholds are
 * stated here and nowhere else, so a reader who disagrees with the wording can
 * see exactly what produced it.
 */
export const offenseRead = (offense: TeamOffense): string => {
  const parts: string[] = [];

  const volume =
    offense.playsPerGamePct === null
      ? null
      : offense.playsPerGamePct > 0.7
        ? 'runs a lot of plays'
        : offense.playsPerGamePct < 0.3
          ? 'runs few plays'
          : null;
  if (volume !== null) parts.push(volume);

  if (offense.proe > 0.03) parts.push('throws more than its situations call for');
  else if (offense.proe < -0.03) parts.push('runs more than its situations call for');

  if (offense.redZonePassRate !== undefined) {
    if (offense.redZonePassRate > 0.6) parts.push('and throws inside the twenty');
    else if (offense.redZonePassRate < 0.45) parts.push('and hands off inside the twenty');
  }

  if (parts.length === 0) {
    return `${offense.team} is close to league average on pace, pass rate and red-zone tendency — this offence is neither helping nor hurting the players in it.`;
  }

  return `${offense.team} ${parts.join(', ')}.`;
};

/**
 * The pressure and box half of a defensive profile.
 *
 * Kept beside the offensive tendencies because a team page needs both sides of
 * the same franchise, and because these are the same *kind* of quantity — a
 * coordinator's choices, not his outcomes. What a defense allows is measured
 * elsewhere and opponent-adjusted; what it chooses to do is measured here and
 * deliberately is not.
 */
export interface TeamPressure {
  readonly team: string;
  readonly dropbacksFaced: number;
  readonly blitzRate: number;
  readonly blitzRatePct: number | null;
  readonly extraRusherRate: number;
  readonly passRushers: number;
  readonly boxCount: number | null;
  readonly boxCountPct: number | null;
  readonly lightBoxRate: number | null;
  readonly heavyBoxRate: number | null;
}

export interface PressureArtifact {
  readonly generatedAt: string;
  readonly note: string;
  readonly teams: Readonly<Record<string, TeamPressure>>;
}

let pressureCache: PressureArtifact | null | undefined;

export const loadPressure = async (): Promise<PressureArtifact | null> => {
  if (pressureCache !== undefined) return pressureCache;
  try {
    const raw = await readArtifactFile('defense-pressure.json');
    pressureCache = raw === null ? null : (JSON.parse(raw) as PressureArtifact);
  } catch {
    pressureCache = null;
  }
  return pressureCache;
};

/**
 * What this defense's choices mean for the players facing it.
 *
 * Stated as a tension rather than a verdict, because that is what the evidence
 * supports: this repository has measured twice that opponent strength does not
 * move a projection, so the honest framing is "here is what they do, and here is
 * the shape of week it tends to produce" — not "start your back".
 */
export const pressureRead = (pressure: TeamPressure): string => {
  const parts: string[] = [];

  if (pressure.blitzRate > 0.35) {
    parts.push(
      'blitzes as much as anyone, which widens the range of quarterback outcomes in both directions — more sacks and more explosives, rarely a quiet afternoon',
    );
  } else if (pressure.blitzRate < 0.25) {
    parts.push(
      'rushes four and drops seven, which tends to compress a quarterback toward his median: fewer disasters, fewer explosives',
    );
  }

  if (pressure.lightBoxRate !== null && pressure.lightBoxRate > 0.72) {
    parts.push('and plays a light box, inviting the run');
  } else if (pressure.heavyBoxRate !== null && pressure.heavyBoxRate > 0.12) {
    parts.push('and loads the box, daring the pass');
  }

  if (parts.length === 0) {
    return `${pressure.team} is near league average on pressure and box count — a defense with no strong tendency to plan around.`;
  }
  return `${pressure.team} ${parts.join(' ')}.`;
};
