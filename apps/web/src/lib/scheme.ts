import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_TTL_MS, memoize } from './cache';

/**
 * Defensive scheme, and what it means for the offence facing it.
 *
 * Most tools express a matchup as a single rank — "the 28th-hardest defense" —
 * which is both opaque and, applied player-by-player, arithmetically wrong:
 * eleven receivers cannot each gain 8% of the targets. Scheme is different. It
 * is a description of *how* a defense plays, it applies to the whole offence at
 * once, and it points in different directions for different positions. A
 * two-high shell that suppresses a deep threat is the same shell that empties
 * the box for a running back.
 *
 * So this module carries the tendencies and the reading, not a score.
 */

export interface SchemePercentiles {
  readonly blitz_rate: number;
  readonly pressure_rate: number;
  readonly man_rate: number;
  readonly two_high_rate: number;
  readonly light_box_rate: number;
  readonly mean_time_to_throw: number;
}

export interface DefenseProfile {
  readonly team: string;
  readonly season: number;
  readonly plays: number;
  readonly blitz_rate: number;
  readonly pressure_rate: number;
  readonly man_rate: number;
  readonly two_high_rate: number;
  readonly light_box_rate: number;
  readonly mean_time_to_throw: number;
  readonly percentiles: SchemePercentiles;
}

export interface OffenceProfile {
  readonly season: number;
  readonly plays_per_game: number;
  readonly seconds_per_play: number;
  readonly pass_rate: number;
  /** Dropback share minus what the situation called for. Positive = pass-first. */
  readonly proe: number;
  readonly neutral_pass_rate: number;
  readonly percentiles: { readonly proe: number; readonly plays_per_game: number };
}

export interface PositionAllowance {
  readonly raw: number;
  /** Points allowed per game, credited for the offences actually faced. */
  readonly adjusted: number;
  /** 0-1, oriented so higher always means better for the offence. */
  readonly softness: number;
}

export interface SchemeArtifact {
  readonly offences: Record<string, OffenceProfile>;
  readonly defenseVsPosition: Record<string, Record<string, PositionAllowance>>;
  readonly artifactVersion: string;
  readonly generatedAt: string;
  readonly season: number;
  readonly week: number;
  /** The completed season these tendencies describe. */
  readonly schemeSeason: number;
  readonly defenses: Record<string, DefenseProfile>;
  readonly matchups: Record<string, { readonly opponent: string; readonly venue: string }>;
}

const ARTIFACT_DIR = join(process.cwd(), '..', '..', 'model', 'artifacts');

const readSchemeArtifact = async (season: number, week: number): Promise<SchemeArtifact | null> => {
  try {
    const path = join(ARTIFACT_DIR, `scheme-${season}-${String(week).padStart(2, '0')}.json`);
    return JSON.parse(await readFile(path, 'utf8')) as SchemeArtifact;
  } catch {
    return null;
  }
};

export const loadScheme = memoize(
  readSchemeArtifact,
  (season, week) => `${season}-${week}`,
  ARTIFACT_TTL_MS,
  'scheme',
);

/** A tendency worth mentioning, with the direction it pushes this position. */
export interface SchemeRead {
  readonly label: string;
  /** 0-1 percentile within the league. */
  readonly percentile: number;
  /** What it does to this player: helps, hurts, or is merely context. */
  readonly direction: 'helps' | 'hurts' | 'neutral';
  readonly note: string;
}

/** Only tendencies this far from the middle are worth a manager's attention. */
const NOTABLE = 0.75;

/**
 * How one defense's tendencies bear on one position.
 *
 * The causal chain runs quarterback-first, because he is the valve: a defense
 * acts on the passing game as a whole, and pass catchers inherit a changed
 * *allocation* rather than an independent adjustment. That is why a two-high
 * shell reads as a negative for a deep receiver and a positive for a back —
 * it is one cause with two signs, not two separate effects.
 */
export const readScheme = (
  defense: DefenseProfile,
  position: string,
  /** The offence this player plays in, when known. */
  offence?: OffenceProfile,
  /** What this defense concedes to this position, when known. */
  allowance?: PositionAllowance,
): SchemeRead[] => {
  const reads: SchemeRead[] = [];
  const p = defense.percentiles;

  /*
   * The headline read: what this defense actually concedes to this position,
   * with credit for the offences it faced.
   *
   * Scheme tendencies explain *why* a matchup is what it is; this is the
   * outcome those tendencies produce, and it is the number to lead with. It is
   * also the one that is directly comparable across positions — which is what
   * makes "they are stout against receivers but soft against backs" a sentence
   * the data can actually support.
   */
  if (allowance !== undefined) {
    if (allowance.softness >= NOTABLE) {
      reads.push({
        label: `Soft against ${position}s`,
        percentile: allowance.softness,
        direction: 'helps',
        note: `Concedes ${allowance.adjusted.toFixed(1)} points a game to the position after adjusting for who it played.`,
      });
    } else if (allowance.softness <= 1 - NOTABLE) {
      reads.push({
        label: `Tough against ${position}s`,
        percentile: 1 - allowance.softness,
        direction: 'hurts',
        note: `Concedes only ${allowance.adjusted.toFixed(1)} points a game to the position, schedule-adjusted.`,
      });
    }
  }

  /*
   * Team behaviour, which sets the volume everything else divides up.
   *
   * A back on a run-heavy offence and a back on a pass-first one are not the
   * same asset even at identical talent, and pass rate over expected is the
   * version of that fact which survives game script.
   */
  if (offence !== undefined) {
    const passy = offence.percentiles.proe;
    const isPassCatcher = position === 'WR' || position === 'TE' || position === 'QB';

    if (passy >= NOTABLE) {
      reads.push({
        label: 'Pass-first offence',
        percentile: passy,
        direction: isPassCatcher ? 'helps' : 'hurts',
        note: `Throws ${(offence.proe * 100).toFixed(1)}% more than the situation calls for, so targets are plentiful and carries are not.`,
      });
    } else if (passy <= 1 - NOTABLE) {
      reads.push({
        label: 'Run-heavy offence',
        percentile: 1 - passy,
        direction: position === 'RB' ? 'helps' : 'hurts',
        note: `Runs ${Math.abs(offence.proe * 100).toFixed(1)}% more than expected for the situation — carries concentrate here.`,
      });
    }

    if (offence.percentiles.plays_per_game >= NOTABLE) {
      reads.push({
        label: 'Fast pace',
        percentile: offence.percentiles.plays_per_game,
        direction: 'helps',
        note: `${offence.plays_per_game.toFixed(1)} plays a game. More snaps is more of everything, for everyone in this offence.`,
      });
    }
  }

  const high = (value: number) => value >= NOTABLE;
  const low = (value: number) => value <= 1 - NOTABLE;

  if (high(p.two_high_rate)) {
    reads.push({
      label: 'Two-high shell',
      percentile: p.two_high_rate,
      direction: position === 'RB' ? 'helps' : position === 'WR' ? 'hurts' : 'neutral',
      note:
        position === 'RB'
          ? 'Two safeties deep means one fewer defender in the box — the cleanest run-game tailwind there is.'
          : 'Two deep safeties compress the deep third and push targets underneath. Volume survives; explosive plays do not.',
    });
  }

  if (low(p.two_high_rate)) {
    reads.push({
      label: 'Single-high shell',
      percentile: 1 - p.two_high_rate,
      direction: position === 'WR' ? 'helps' : position === 'RB' ? 'hurts' : 'neutral',
      note:
        position === 'WR'
          ? 'One deep safety leaves the outside in single coverage — where the long touchdowns come from.'
          : 'A single-high shell keeps an extra defender near the line against the run.',
    });
  }

  if (high(p.blitz_rate) || high(p.pressure_rate)) {
    reads.push({
      label: high(p.blitz_rate) ? 'Heavy blitz' : 'Wins without blitzing',
      percentile: Math.max(p.blitz_rate, p.pressure_rate),
      direction: position === 'QB' ? 'hurts' : position === 'TE' ? 'helps' : 'neutral',
      note:
        position === 'QB'
          ? 'Pressure shortens the clock and raises the interception rate — the single biggest drag on quarterback scoring.'
          : position === 'TE'
            ? 'The hot read against pressure is usually the tight end, which lifts his floor even as the offence struggles.'
            : 'Pressure shortens throws, moving volume from deep routes to the quick game.',
    });
  }

  if (high(p.man_rate)) {
    reads.push({
      label: 'Man coverage',
      percentile: p.man_rate,
      direction: 'neutral',
      note: 'Man coverage widens outcomes: a separator feasts, and everyone else disappears. Expect variance, not a mean shift.',
    });
  }

  if (position === 'RB' && low(p.light_box_rate)) {
    reads.push({
      label: 'Stacks the box',
      percentile: 1 - p.light_box_rate,
      direction: 'hurts',
      note: 'This defense keeps seven or more in the box against the run more than almost anyone. Efficiency suffers even when volume holds.',
    });
  }

  if (position === 'RB' && high(p.light_box_rate)) {
    reads.push({
      label: 'Light boxes',
      percentile: p.light_box_rate,
      direction: 'helps',
      note: 'Six or fewer in the box on most run plays — yards before contact come easier here.',
    });
  }

  return reads;
};
