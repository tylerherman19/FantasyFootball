import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What the scheme read is worth, in points, at the decision it bears on.
 *
 * The scheme page had a real problem: it described defenses accurately and
 * never once said what to do about it. A manager reading "Denver plays two
 * safeties deep" has learned something, but not something that changes a
 * lineup — and a decision-support product that stops at description is a
 * magazine.
 *
 * The honest answer turns out to be sharper than the dishonest one. Scheme has
 * now been measured three separate times against the projection it is supposed
 * to inform:
 *
 * 1. Scaled the projected points by opponent strength. MAE got worse.
 * 2. Scaled only opportunity, leaving efficiency alone. MAE got worse.
 * 3. Left the mean alone and asked whether scheme moves the *spread* — the
 *    claim that a two-high shell clips a receiver's ceiling while opening a
 *    back's floor. It does not: WR 0.997, RB 1.005, separation 0.008.
 *
 * The third is the one this module is built on, because it converts to points.
 * If shell posture could move a player's spread by more than 0.8% and the
 * measurement missed it, that is the size of thing 21,679 player-weeks failed
 * to detect. Multiply that fraction by a player's own spread and you get a
 * per-player ceiling on any scheme effect in the units the decision is made in.
 *
 * That ceiling is then set against the margin the decision actually has. A
 * start/sit call with 2.3 points between the two options cannot be flipped by
 * something bounded at 0.06, and saying so is more useful than a colour-coded
 * matchup grade — it tells the manager to stop thinking about it.
 */

/** One tercile bucket of the variance study. */
export interface SchemeBucket {
  readonly position: string;
  readonly bucket: string;
  readonly n: number;
  readonly residualSd: number;
  readonly meanZ: number;
  readonly aboveP90: number;
  readonly thin: boolean;
}

export interface SchemeFinding {
  readonly n: number;
  readonly seasons: readonly number[];
  readonly terciles: { readonly loadedBoxBelow: number; readonly softShellAbove: number };
  readonly buckets: readonly SchemeBucket[];
  readonly ratios: Readonly<Record<string, number>>;
  readonly separation: number;
  readonly verdict: 'declined' | 'directional' | 'partial' | 'insufficient';
}

let cached: SchemeFinding | null | undefined;

export const loadSchemeFinding = async (): Promise<SchemeFinding | null> => {
  if (cached !== undefined) return cached;
  try {
    const path = join(process.cwd(), '..', '..', 'model', 'artifacts', 'scheme-variance.json');
    cached = JSON.parse(await readFile(path, 'utf8')) as SchemeFinding;
  } catch {
    // Absent artifact means the study has not been run in this checkout. The
    // pages degrade to describing scheme without quantifying it, which is where
    // they were before — never to a fabricated number.
    cached = null;
  }
  return cached;
};

/**
 * The largest movement in points that scheme could produce for this player
 * without the variance study having seen it.
 *
 * Deliberately generous: it uses the *whole* measured separation as though it
 * were a real effect rather than sampling noise, and applies it to the player's
 * full spread. A bound computed the flattering way and still coming out small
 * is a stronger statement than one tuned to look small.
 */
export const schemeBound = (sd: number, finding: SchemeFinding | null): number => {
  if (finding === null || finding.verdict === 'directional') return Number.NaN;
  return Math.abs(sd) * finding.separation;
};

export interface CallVerdict {
  /** Points between this starter and the best alternative for his slot. */
  readonly margin: number;
  /** Ceiling on what scheme could move, in points. */
  readonly bound: number;
  /** The alternative the margin is measured against, if there is one. */
  readonly alternative: string | null;
  /** True when the margin is smaller than the bound — i.e. genuinely close. */
  readonly couldFlip: boolean;
  readonly sentence: string;
}

/**
 * Enough precision to make the comparison legible.
 *
 * One decimal is right for a projection and wrong here: a margin of 0.04 prints
 * as "0.0 pts", which sits in the same sentence as a bound of "±0.04" and reads
 * as a contradiction — the reader is told the gap is nothing and then told
 * nothing cannot close it. Where the two quantities are the same size, show
 * them at the same size.
 */
const points = (value: number): string => (Math.abs(value) < 0.1 ? value.toFixed(2) : value.toFixed(1));

/**
 * Does the scheme read change this start/sit call?
 *
 * Almost always no, and the page should say no in words rather than leaving a
 * red arrow next to a player and letting the manager draw the wrong conclusion
 * from it. The rare yes is worth flagging loudly for exactly that reason.
 */
export const callVerdict = (
  margin: number,
  sd: number,
  alternative: string | null,
  finding: SchemeFinding | null,
): CallVerdict => {
  const bound = schemeBound(sd, finding);

  if (Number.isNaN(bound)) {
    return {
      margin,
      bound,
      alternative,
      couldFlip: false,
      sentence: 'Scheme effect not measured in this build — read the matchup as context only.',
    };
  }

  if (alternative === null) {
    return {
      margin,
      bound,
      alternative,
      couldFlip: false,
      sentence: `No alternative on your bench for this slot, so the matchup cannot change anything. Scheme is worth at most ±${bound.toFixed(2)} pts to him either way.`,
    };
  }

  const couldFlip = margin < bound;

  return {
    margin,
    bound,
    alternative,
    couldFlip,
    sentence: couldFlip
      ? `Genuinely close — ${points(margin)} pts over ${alternative}, inside the ±${bound.toFixed(2)} that scheme could be worth. This is the rare call where the matchup is not irrelevant.`
      : `Starts over ${alternative} by ${points(margin)} pts. Scheme is worth at most ±${bound.toFixed(2)} pts, so the read below is context — it does not change the call.`,
  };
};

/** How many of a set of calls the matchup could actually reach. */
export const flippableCount = (verdicts: readonly CallVerdict[]): number =>
  verdicts.filter((v) => v.couldFlip).length;
