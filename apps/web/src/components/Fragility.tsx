'use client';

import { useMemo, useState } from 'react';
import { injuryScenarios, type InjuryScenario } from '@/lib/client-sim';
import type { WireLeague } from '@/lib/serialize';

/**
 * What your season is actually resting on (§60).
 *
 * The player-level what-if asks "what if his role changed". This asks "what if
 * he is gone", which is a different question with a different answer, because
 * the answer is not about him — it is about how much of your title probability
 * was riding on one man, and what your bench does when it has to cover.
 *
 * Removal rather than a projection haircut. A season-ending injury is not "he
 * scores less"; it is the lineup solver having to find somebody else every week.
 * Halving his projection would understate the cost exactly when the bench is
 * thin, which is exactly when it matters.
 *
 * Runs in the browser, on demand rather than on load: it is N full season
 * simulations and nobody should pay for that unless they asked the question.
 */

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const Fragility = ({
  wire,
  myTeamId,
  candidates,
}: {
  readonly wire: WireLeague;
  readonly myTeamId: string;
  /** The starters worth testing. Simulating the whole bench is wasted work. */
  readonly candidates: readonly { readonly id: string; readonly name: string }[];
}) => {
  const [results, setResults] = useState<InjuryScenario[] | null>(null);
  const [running, setRunning] = useState(false);

  const ids = useMemo(() => candidates.map((c) => c.id), [candidates]);

  const run = (): void => {
    setRunning(true);
    // Yield first so the button paints its running state before the main thread
    // disappears into a few thousand simulated seasons.
    setTimeout(() => {
      try {
        setResults(injuryScenarios(wire, myTeamId, ids));
      } finally {
        setRunning(false);
      }
    }, 16);
  };

  if (results === null) {
    return (
      <div>
        <button
          type="button"
          onClick={run}
          disabled={running || ids.length === 0}
          className="text-sm underline"
          style={{ color: running ? 'var(--ink-faint)' : 'var(--ink)' }}
        >
          {running
            ? `Simulating ${ids.length} seasons without each starter…`
            : `Test what happens if a starter goes down`}
        </button>
        <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
          {ids.length} full season simulations, run here in the browser. Not done on load, because
          nobody should pay for it who did not ask.
        </p>
      </div>
    );
  }

  const worst = results[0];
  const maxCost = Math.max(...results.map((r) => Math.abs(r.titleCost)), 0.001);

  return (
    <div className="max-w-2xl">
      {worst !== undefined && (
        <p className="mb-4 text-base leading-relaxed">
          {worst.shareOfOdds > 0.3 ? (
            <>
              <strong>{worst.name} is your season.</strong> Losing him takes your title odds from{' '}
              {pct(worst.titleBefore)} to {pct(worst.titleAfter)} — {(worst.shareOfOdds * 100).toFixed(0)}%
              of everything you have. That is a roster built on one man, which is fine when he plays
              and unrecoverable when he does not.
            </>
          ) : (
            <>
              <strong>No single injury ends your season.</strong> The most costly is {worst.name} at{' '}
              {(worst.titleCost * 100).toFixed(1)} points of title probability —{' '}
              {(worst.shareOfOdds * 100).toFixed(0)}% of your total. A roster that survives its worst
              week is worth more than one that is better on its best.
            </>
          )}
        </p>
      )}

      <table className="w-full">
        <thead>
          <tr className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            <th className="pb-1 text-left font-normal">Without</th>
            <th className="pb-1 text-right font-normal">Title odds</th>
            <th className="pb-1 pl-4 text-left font-normal">Cost</th>
            <th className="pb-1 text-right font-normal">Share</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr
              key={r.playerId}
              className="border-t align-baseline"
              style={{ borderColor: 'var(--rule)' }}
              title={`${r.name}: title ${pct(r.titleBefore)} → ${pct(r.titleAfter)}, playoffs ${pct(r.playoffBefore)} → ${pct(r.playoffAfter)}`}
            >
              <td className="py-1.5 pr-3 text-sm">{r.name}</td>
              <td className="tabular py-1.5 text-right text-sm">{pct(r.titleAfter)}</td>
              <td className="py-1.5 pl-4">
                <div className="h-2 w-full" style={{ minWidth: '5rem' }}>
                  <div
                    className="h-2"
                    style={{
                      width: `${(Math.abs(r.titleCost) / maxCost) * 100}%`,
                      background: r.titleCost > 0 ? 'var(--neg)' : 'var(--pos)',
                    }}
                  />
                </div>
              </td>
              <td
                className="tabular py-1.5 text-right text-sm"
                style={{ color: r.shareOfOdds > 0.25 ? 'var(--neg)' : 'var(--ink-muted)' }}
              >
                {(r.shareOfOdds * 100).toFixed(0)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        Each row removes that player and re-simulates the season — the lineup solver has to cover
        him from your actual bench, so the cost is whatever the next man up cannot do. A negative
        cost means the solver was starting him over somebody better.
      </p>
    </div>
  );
};
