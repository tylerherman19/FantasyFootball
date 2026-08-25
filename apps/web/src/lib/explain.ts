import { scoreStatLine } from '@ffe/core';
import type { ArtifactPlayer } from './projections';

/**
 * Turn the model's own decomposition into a waterfall, in this league's points.
 *
 * The model computes fantasy scoring as an identity — `Σ(opportunity × rate ×
 * weight)` — and already evaluates each half separately before multiplying. The
 * export keeps the intermediate stat lines, so the steps below are arithmetic
 * performed on real model state, not a story told about a finished number.
 *
 * That distinction is the whole point. A `Why?` panel that reverse-engineers a
 * plausible explanation is worse than none: it is confident, it is legible, and
 * it is unfalsifiable. These steps sum to the projection exactly, and if they
 * ever stop doing so the test says so.
 *
 * Scored here rather than in the model because points are per league — the same
 * decomposition is worth different amounts in a PPR league and a TE-premium one.
 */

export interface WaterfallStep {
  readonly label: string;
  readonly value: number;
  readonly note: string;
}

export interface Explanation {
  readonly steps: readonly WaterfallStep[];
  readonly total: number;
  /** Recency-weighted games behind the estimate. Drives confidence. */
  readonly effectiveGames: number;
  /** True when there is no history to decompose. */
  readonly isPrior: boolean;
  readonly confidence: number;
  readonly confidenceReasons: readonly string[];
  readonly scheme?: {
    readonly team?: string;
    readonly paceMultiplier?: number;
    readonly passShape?: number;
    readonly runShape?: number;
  };
}

/**
 * Confidence, from sample size and what the projection rests on.
 *
 * Deliberately crude and deliberately honest: it reports how much the model has
 * seen, not how good it feels. A rookie priced entirely off draft capital is
 * capped low no matter how attractive the number is, because the number is a
 * prior and priors are not evidence.
 *
 * The curve is the same shrinkage logic used everywhere else — `n / (n + k)` —
 * so a player with twelve recency-weighted games lands near 0.7 rather than
 * being declared certain.
 */
const confidenceOf = (
  effectiveGames: number,
  isPrior: boolean,
  injuryStatus: string | null,
): { confidence: number; reasons: string[] } => {
  const reasons: string[] = [];

  if (isPrior) {
    reasons.push('No NFL snaps — this is a draft-capital prior, not an observation');
  }

  let confidence = isPrior ? 0.25 : effectiveGames / (effectiveGames + 5);

  if (!isPrior && effectiveGames < 6) {
    reasons.push(`Only ${effectiveGames.toFixed(1)} recency-weighted games of history`);
  }

  if (injuryStatus !== null && injuryStatus !== '') {
    reasons.push(`Listed ${injuryStatus.toLowerCase()} — availability is unsettled`);
    confidence *= 0.8;
  }

  return { confidence: Math.max(0.05, Math.min(0.95, confidence)), reasons };
};

/** Confidence for decision code that does not need the full waterfall. */
export const projectionConfidence = (
  effectiveGames: number,
  isPrior: boolean,
  injuryStatus: string | null = null,
): number => confidenceOf(effectiveGames, isPrior, injuryStatus).confidence;

export const explain = (
  player: ArtifactPlayer,
  rules: Readonly<Record<string, number>>,
  injuryStatus: string | null = null,
): Explanation => {
  const why = player.why;
  const total = Math.max(0, scoreStatLine(player.stats ?? {}, rules));
  const effectiveGames = why?.effectiveGames ?? 0;
  const isPrior = player.basis === 'rookie-prior' || why?.prior === undefined;

  const { confidence, reasons } = confidenceOf(effectiveGames, isPrior, injuryStatus);

  /*
   * A rookie gets one bar, not a waterfall.
   *
   * With no history there is no prior line and no opportunity line, so a
   * decomposition would put the entire projection in the last bucket and label
   * it "efficiency" — which would be precisely backwards. The number is draft
   * capital and a depth chart; saying so is the explanation.
   */
  if (isPrior) {
    return {
      steps: [
        {
          label: 'Draft-capital prior',
          value: total,
          note: 'Fitted on ten rookie classes: expected opportunity by draft slot, adjusted for depth chart',
        },
      ],
      total,
      effectiveGames,
      isPrior: true,
      confidence,
      confidenceReasons: reasons,
      ...(why.scheme === undefined ? {} : { scheme: why.scheme }),
    };
  }

  const prior = Math.max(0, scoreStatLine(why.prior ?? {}, rules));
  const baseOpportunity = Math.max(
    0,
    scoreStatLine(why.baseOpportunity ?? why.opportunity ?? {}, rules),
  );
  const opportunity = Math.max(0, scoreStatLine(why.opportunity ?? {}, rules));
  const schemeDelta = opportunity - baseOpportunity;

  const steps = [
    {
      label: `Average ${player.position}`,
      value: prior,
      note: 'What the model says about a player it knows nothing about beyond his position',
    },
    {
      label: 'Player opportunity',
      value: baseOpportunity - prior,
      note: 'His projected targets, carries and attempts before team scheme context',
    },
    ...(why.baseOpportunity === undefined
      ? []
      : [
          {
            label: 'Offensive scheme',
            value: schemeDelta,
            note: 'Bounded pace and pass/run identity from the offense he currently plays in',
          },
        ]),
    {
      // Named for what it is. Efficiency is the noisy half and is regressed
      // hard, so a large bar here is unusual and worth distrusting slightly.
      label: 'Efficiency',
      value: total - opportunity,
      note: 'What he does per opportunity — heavily regressed, because efficiency repeats poorly',
    },
  ];

  return {
    steps,
    total,
    effectiveGames,
    isPrior: false,
    confidence,
    confidenceReasons: reasons,
    ...(why.scheme === undefined ? {} : { scheme: why.scheme }),
  };
};

/** Per-game usage the model expects, next to what he has actually been doing. */
export interface UsageRow {
  readonly label: string;
  readonly projected: number;
  readonly observed: number;
}

const USAGE_STATS: readonly { key: string; label: string }[] = [
  { key: 'targets', label: 'Targets' },
  { key: 'carries', label: 'Carries' },
  { key: 'attempts', label: 'Pass attempts' },
];

export const usageRows = (player: ArtifactPlayer): UsageRow[] =>
  USAGE_STATS.flatMap(({ key, label }) => {
    const projected = player.stats?.[key] ?? 0;
    const observed = player.why?.observed?.[key] ?? 0;
    // A quarterback has no carries worth showing and a receiver no attempts;
    // rows that are zero on both sides are noise, not information.
    if (projected < 0.5 && observed < 0.5) return [];
    return [{ label, projected, observed }];
  });
