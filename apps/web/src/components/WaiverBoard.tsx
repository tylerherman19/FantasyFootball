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

  /*
   * Default to the three weakest *projected* players.
   *
   * Players the model cannot project — rookies, most obviously — sort to the
   * bottom on a mean of zero, so the old default nominated a manager's best
   * incoming rookies as the players to cut. An unknown projection is not a low
   * one, and the drop list is the last place to guess.
   */
  const [dropIds, setDropIds] = useState<string[]>(() =>
    myRoster
      .filter((player) => player.projected)
      .slice(0, 3)
      .map((player) => player.id),
  );
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
   * This filter — keep only adds with a positive title delta — is why the wire
   * page reported that nothing helps, almost every week. A fourth receiver moves
   * a season's title probability by less than a browser-side simulation can
   * resolve, so the sign of that delta is close to a coin flip and roughly half
   * of every genuine upgrade was discarded. Showing the ranking and naming the
   * resolution is the honest version: "the best add is worth +0.1%" tells a
   * manager to save their FAAB, which is a real answer.
   */
  const ranked = [...(results ?? [])].sort((a, b) => b.titleDelta - a.titleDelta);

  // Two standard errors at the iteration count the browser sim uses.
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
                  background: selected ? 'var(--surface-sunk)' : 'var(--ground)',
                  color: selected ? 'var(--accent)' : 'var(--ink-muted)',
                  fontWeight: selected ? 600 : 400,
                  border: `1px solid ${selected ? 'var(--accent)' : 'var(--rule)'}`,
                }}
              >
                {player.name}{' '}
                {/* "n/a" rather than 0.0: the model has no read on this player,
                    which is a different statement from projecting him at zero. */}
                <span style={{ opacity: 0.7 }} title={player.projected ? undefined : 'No projection — the model has no NFL data for this player yet'}>
                  {player.projected ? player.mean.toFixed(1) : 'n/a'}
                </span>
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
        <div className="mb-3 border-l-2 px-3 py-2 text-sm"
          style={{ borderColor: 'var(--accent)', background: 'var(--surface-sunk)' }}>
          <strong>No decisive add.</strong> Every option below moves your title odds by less than
          the ±{(RESOLUTION * 100).toFixed(1)}pp this simulation can resolve — they are ranked, but
          the ordering among them is close to a tie.
          {isFaab && ' This is a week to save the FAAB.'}
        </div>
      )}

      {results !== null && ranked.length === 0 && (
        <div className="rounded border p-4 text-sm" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <strong>No free agents to rank.</strong> Nothing is available on this wire.
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
                          ? 'var(--pos)'
                          : result.titleDelta < -RESOLUTION
                            ? 'var(--neg)'
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
