'use client';

import { useMemo, useState, useTransition } from 'react';
import { rankWaiversClient, type WaiverResult } from '@/lib/client-sim';
import type { WireLeague } from '@/lib/serialize';

/**
 * Waiver board, evaluated in the browser.
 *
 * Ranking the wire is dozens of simulations, and the answer depends on which
 * player you are willing to cut — which is a decision, not an input we should be
 * guessing. Running it client-side makes that interactive: choose the drop, see
 * the board re-rank, without waiting on a server that would have had to guess
 * anyway.
 */

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

export const WaiverBoard = ({ league, myTeamId }: { league: WireLeague; myTeamId: string }) => {
  const myRoster = useMemo(() => {
    const team = league.teams.find((t) => t.teamId === myTeamId);
    return (team?.playerIds ?? [])
      .map((id) => league.players[id])
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
      .sort((a, b) => a.mean - b.mean);
  }, [league, myTeamId]);

  // Default to the three weakest players — the ones a manager would consider
  // cutting — but every choice stays available.
  const [dropIds, setDropIds] = useState<string[]>(() => myRoster.slice(0, 3).map((p) => p.id));
  const [results, setResults] = useState<WaiverResult[] | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(() => {
      setResults(rankWaiversClient(league, myTeamId, dropIds));
    });
  };

  const toggleDrop = (id: string) => {
    setDropIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
    setResults(null);
  };

  /*
   * Ranked, not filtered.
   *
   * The same coin-flip problem as the trade finder: a fourth receiver moves a
   * season's title probability by less than a browser-side simulation can
   * resolve, so filtering on the sign discarded roughly half of every genuine
   * upgrade and the wire reported that nothing helps, most weeks.
   */
  const ranked = [...(results ?? [])].sort((a, b) => b.titleDelta - a.titleDelta);
  const RESOLUTION = 2 / Math.sqrt(2_000);
  const anyDecisive = ranked.some((r) => r.titleDelta > RESOLUTION);
  const isFaab = league.waiverType === 'faab';

  return (
    <div>
      <div
        className="mb-6 rounded border p-4"
        style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
      >
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
            Willing to drop
          </span>
          <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            {isFaab
              ? `$${league.remainingBudget} of $${league.seasonBudget} FAAB left`
              : 'waiver priority — no bidding'}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {myRoster.slice(0, 12).map((player) => {
            const selected = dropIds.includes(player.id);
            return (
              <button
                key={player.id}
                type="button"
                onClick={() => toggleDrop(player.id)}
                className="rounded px-2 py-1 text-xs"
                style={{
                  background: selected ? 'var(--accent-soft)' : 'var(--ground)',
                  color: selected ? 'var(--accent)' : 'var(--ink-muted)',
                  fontWeight: selected ? 600 : 400,
                  border: `1px solid ${selected ? 'var(--accent)' : 'var(--rule)'}`,
                }}
              >
                {player.name} <span style={{ opacity: 0.7 }}>{player.mean.toFixed(1)}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="mt-3 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          {pending ? 'Simulating…' : results === null ? 'Rank the wire' : 'Re-rank'}
        </button>
      </div>

      {results !== null && ranked.length > 0 && !anyDecisive && (
        <div className="mb-3 rounded border p-4 text-sm"
          style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <strong>No decisive add.</strong> Every option below moves your title odds by less than
          the ±{(RESOLUTION * 100).toFixed(1)}pp this simulation can resolve — they are ranked, but
          the ordering among them is close to a tie.
          {isFaab && ' This is a week to save the FAAB.'}
        </div>
      )}

      {ranked.length > 0 && (
        <div className="scroll-x">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-widest"
                style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}>
                <th className="py-2">Add</th>
                <th className="py-2">Drop</th>
                <th className="py-2 text-right">Proj.</th>
                <th className="py-2 text-right">Playoff Δ</th>
                <th className="py-2 text-right">Title Δ</th>
                {isFaab && <th className="py-2 text-right">Bid</th>}
              </tr>
            </thead>
            <tbody>
              {ranked.map((result) => (
                <tr key={result.playerId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-2">
                    <span className="font-medium">{result.name}</span>
                    <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                      {result.position} {result.team}
                    </span>
                  </td>
                  <td className="py-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {result.dropName ?? 'open spot'}
                  </td>
                  <td className="tabular py-2 text-right">{result.projected.toFixed(1)}</td>
                  <td className="tabular py-2 text-right" style={{ color: 'var(--ink-muted)' }}>
                    {pct(result.playoffDelta)}
                  </td>
                  <td className="tabular py-2 text-right font-medium"
                    style={{
                      color:
                        result.titleDelta > RESOLUTION
                          ? 'var(--good)'
                          : result.titleDelta < -RESOLUTION
                            ? 'var(--bad)'
                            : 'var(--ink-faint)',
                    }}>
                    {pct(result.titleDelta)}
                  </td>
                  {isFaab && (
                    <td className="tabular py-2 text-right font-medium">${result.suggestedBid}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
