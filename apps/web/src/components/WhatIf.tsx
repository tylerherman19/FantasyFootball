'use client';

import { useMemo, useState } from 'react';
import { scoreStatLine } from '@ffe/core';

/**
 * What if his role changed?
 *
 * The brief's §30 and §60. Every other number in this product answers "what does
 * the model think"; this one answers "what would have to be true for me to be
 * right", which is the question a manager actually argues with themselves about
 * on Wednesday.
 *
 * It is principled rather than a slider over the output. The model builds a
 * projection as an identity — `Σ(opportunity × rate × weight)` — and the export
 * keeps the opportunity and rate halves separately. So moving opportunity here
 * recomputes points through *the model's own arithmetic*, holding efficiency
 * fixed: exactly what "he sees three more targets a game" means. A slider that
 * simply scaled the final number would be a different and much weaker claim,
 * because it would silently scale his touchdown rate too.
 *
 * Runs entirely in the browser. Nothing to fetch, nothing to wait for, and the
 * scoring is the same `scoreStatLine` the server used — so a what-if cannot
 * disagree with the projection it started from.
 */

const RATE_PAIRS: readonly (readonly [string, string])[] = [
  ['completions', 'attempts'],
  ['passing_yards', 'attempts'],
  ['passing_tds', 'attempts'],
  ['passing_interceptions', 'attempts'],
  ['rushing_yards', 'carries'],
  ['rushing_tds', 'carries'],
  ['receptions', 'targets'],
  ['receiving_yards', 'targets'],
  ['receiving_tds', 'targets'],
];

/** Which opportunity stat this position's week actually turns on. */
const DRIVER: Readonly<Record<string, { key: string; label: string }>> = {
  QB: { key: 'attempts', label: 'Pass attempts per game' },
  RB: { key: 'carries', label: 'Carries per game' },
  WR: { key: 'targets', label: 'Targets per game' },
  TE: { key: 'targets', label: 'Targets per game' },
};

export const WhatIf = ({
  stats,
  position,
  rules,
  baseline,
}: {
  readonly stats: Readonly<Record<string, number>>;
  readonly position: string;
  readonly rules: Readonly<Record<string, number>>;
  readonly baseline: number;
}) => {
  const driver = DRIVER[position];
  const current = driver === undefined ? 0 : (stats[driver.key] ?? 0);

  const [volume, setVolume] = useState(current);
  const [efficiency, setEfficiency] = useState(1);

  const projected = useMemo(() => {
    if (driver === undefined || current <= 0) return baseline;

    const next: Record<string, number> = { ...stats, [driver.key]: volume };

    // Rates are held fixed and the counting stats move with their denominator.
    // This is the whole point: "more targets" must not silently mean "and a
    // better touchdown rate", which is what scaling the output would imply.
    for (const [stat, denominator] of RATE_PAIRS) {
      if (denominator !== driver.key) continue;
      const rate = current > 0 ? (stats[stat] ?? 0) / current : 0;
      next[stat] = rate * volume * efficiency;
    }

    return Math.max(0, scoreStatLine(next, rules));
  }, [stats, driver, current, volume, efficiency, rules, baseline]);

  if (driver === undefined || current <= 0) return null;

  const delta = projected - baseline;
  const max = Math.max(current * 2, current + 6);

  return (
    <div className="max-w-2xl">
      <div className="mb-5 flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <div>
          <div className="eyebrow mb-1">Projection under these assumptions</div>
          <div className="flex items-baseline gap-3">
            <span className="tabular text-3xl font-semibold">{projected.toFixed(1)}</span>
            <span
              className="tabular text-sm font-medium"
              style={{
                color:
                  Math.abs(delta) < 0.05
                    ? 'var(--ink-faint)'
                    : delta > 0
                      ? 'var(--pos)'
                      : 'var(--neg)',
              }}
            >
              {Math.abs(delta) < 0.05
                ? 'unchanged'
                : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} vs the model`}
            </span>
          </div>
        </div>
      </div>

      <label className="mb-5 block">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-sm">{driver.label}</span>
          <span className="tabular text-sm font-medium">
            {volume.toFixed(1)}
            <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
              model says {current.toFixed(1)}
            </span>
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={volume}
          onChange={(event) => setVolume(Number(event.target.value))}
          className="w-full"
          aria-label={driver.label}
        />
      </label>

      <label className="mb-4 block">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-sm">Efficiency per opportunity</span>
          <span className="tabular text-sm font-medium">
            {efficiency.toFixed(2)}×
            <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
              model says 1.00×
            </span>
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.01}
          value={efficiency}
          onChange={(event) => setEfficiency(Number(event.target.value))}
          className="w-full"
          aria-label="Efficiency per opportunity"
        />
      </label>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => {
            setVolume(current);
            setEfficiency(1);
          }}
          className="text-xs underline"
          style={{ color: 'var(--ink-muted)' }}
        >
          Reset to the model
        </button>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
          Volume moves the counting stats through the same identity the model uses; efficiency is a
          separate multiplier, because they are separate claims.
        </p>
      </div>
    </div>
  );
};
