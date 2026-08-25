import type { Position } from '../domain/index.js';

/**
 * Scheme is a context feature, not a second projection system.
 *
 * The projection owns the mean. This layer supplies a deliberately small,
 * auditable signal for decisions that need to distinguish two similarly priced
 * players: offensive opportunity, defensive posture, and role. The cap keeps a
 * one-week matchup from overwhelming a multi-year dynasty market price.
 */

export interface OffensiveSchemeProfile {
  readonly team: string;
  readonly passRate: number;
  readonly neutralPassRate?: number;
  readonly proe?: number;
  readonly playsPerGame?: number;
}

export interface DefensiveSchemeProfile {
  readonly team: string;
  /** Positive = more two-high / light-box behaviour. */
  readonly shellIndex: number;
  /** Positive = more pressure than league average. */
  readonly pressureIndex: number;
  readonly passEpaAdjusted?: number;
  readonly rushEpaAdjusted?: number;
  readonly targetShareAllowed?: Readonly<Partial<Record<'RB' | 'WR' | 'TE', number>>>;
}

export interface PlayerSchemeContext {
  readonly position: Extract<Position, 'QB' | 'RB' | 'WR' | 'TE'>;
  readonly targetShare?: number;
  readonly carryShare?: number;
  readonly offense?: OffensiveSchemeProfile;
  readonly defense?: DefensiveSchemeProfile;
}

export interface SchemeSignal {
  /** -1 to 1; positive means the context is favourable for this player. */
  readonly score: number;
  /** A small confidence-weighted tie-breaker for trade ranking. */
  readonly decisionWeight: number;
  readonly reasons: readonly string[];
}

const clamp = (value: number, min = -1, max = 1): number => Math.max(min, Math.min(max, value));
const deviation = (value: number | undefined, baseline: number): number =>
  value === undefined ? 0 : clamp((value - baseline) * 4);

/**
 * Convert offensive and defensive scheme context to one bounded signal.
 *
 * This intentionally rewards volume signals more than matchup labels. A team
 * that actually throws more, runs more plays, or concentrates targets has a
 * stronger fantasy implication than a generic "good matchup" badge.
 */
export const schemeSignal = (context: PlayerSchemeContext): SchemeSignal => {
  const offense = context.offense;
  const defense = context.defense;
  const reasons: string[] = [];
  const components: number[] = [];

  if (offense !== undefined) {
    const passRate = deviation(offense.neutralPassRate ?? offense.passRate, 0.6);
    const pace = deviation(offense.playsPerGame, 64);
    const proe = deviation(offense.proe, 0);

    if (context.position === 'QB' || context.position === 'WR' || context.position === 'TE') {
      components.push(passRate * 0.55 + pace * 0.2 + proe * 0.25);
      if (passRate > 0.15) reasons.push('pass-heavy offense');
      if (pace > 0.15) reasons.push('above-average play volume');
    } else if (context.position === 'RB') {
      components.push(-passRate * 0.45 + pace * 0.2 - proe * 0.15);
      if (passRate < -0.15) reasons.push('run-leaning offense');
    }

    if (context.targetShare !== undefined && context.position !== 'RB') {
      const concentration = clamp((context.targetShare - 0.18) * 3);
      components.push(concentration * 0.35);
      if (concentration > 0.2) reasons.push('meaningful target share');
    }

    if (context.carryShare !== undefined && context.position === 'RB') {
      const concentration = clamp((context.carryShare - 0.2) * 2.5);
      components.push(concentration * 0.3);
      if (concentration > 0.2) reasons.push('meaningful carry share');
    }
  }

  if (defense !== undefined) {
    const shell = clamp(defense.shellIndex);
    const pressure = clamp(defense.pressureIndex);
    const passEpa = clamp((defense.passEpaAdjusted ?? 0) * 6);
    const rushEpa = clamp((defense.rushEpaAdjusted ?? 0) * 7);

    if (context.position === 'RB') {
      components.push(shell * 0.2 + rushEpa * 0.45);
      if (shell > 0.35) reasons.push('light-box tendency');
      if (rushEpa > 0.2) reasons.push('soft adjusted run defense');
    } else if (context.position === 'QB') {
      components.push(passEpa * 0.35 - pressure * 0.35);
      if (pressure < -0.25) reasons.push('below-average pressure');
      if (pressure > 0.25) reasons.push('pressure risk');
    } else {
      const allowed = defense.targetShareAllowed?.[context.position];
      const baseline = context.position === 'TE' ? 0.22 : 0.58;
      components.push((allowed === undefined ? 0 : (allowed - baseline) * 3) * 0.25 + passEpa * 0.2);
      if (allowed !== undefined && allowed > baseline + 0.03) reasons.push('defense funnels targets here');
    }
  }

  const score = clamp(components.length === 0 ? 0 : components.reduce((a, b) => a + b, 0) / components.length);
  return {
    score,
    // Only a small part of a trade recommendation may come from scheme. This
    // is current context, not a replacement for multi-season projection value.
    decisionWeight: score * 0.08,
    reasons: reasons.slice(0, 3),
  };
};
