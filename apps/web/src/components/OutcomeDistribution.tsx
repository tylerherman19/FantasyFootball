/**
 * Where the season can land.
 *
 * A single "7.0 projected wins" hides the thing that actually matters — the
 * spread. A team projected at 7 wins with a tight distribution is a different
 * proposition from one that ranges 3 to 11, even though the headline number is
 * identical, and the second is far more likely to either make a run or collapse.
 *
 * Drawn as bars over final win totals, with the playoff cut marked so the
 * question "how much of my distribution is on the right side of the line" is
 * answerable by looking.
 */

export const OutcomeDistribution = ({
  winDistribution,
  expectedWins,
  playoffPct,
}: {
  /** Share of simulated seasons finishing with exactly N wins, index = N. */
  winDistribution: readonly number[];
  expectedWins: number;
  playoffPct: number;
}) => {
  const max = Math.max(...winDistribution, 0.0001);
  const totalWeeks = winDistribution.length - 1;

  return (
    <div>
      <div className="flex items-end gap-1" style={{ height: 96 }}>
        {winDistribution.map((share, wins) => {
          const height = Math.max(share > 0 ? 2 : 0, (share / max) * 92);
          const isLikely = Math.abs(wins - expectedWins) < 1;

          return (
            <div key={wins} className="flex flex-1 flex-col items-center justify-end" title={`${wins} wins: ${(share * 100).toFixed(1)}%`}>
              <div
                style={{
                  height,
                  width: '100%',
                  background: isLikely ? 'var(--accent)' : 'var(--p-mid)',
                  opacity: isLikely ? 1 : 0.55,
                  borderRadius: 2,
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-1 flex gap-1">
        {winDistribution.map((_, wins) => (
          <div key={wins} className="flex-1 text-center text-[10px]" style={{ color: 'var(--ink-faint)' }}>
            {wins}
          </div>
        ))}
      </div>

      <p className="mt-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
        Most likely around <strong style={{ color: 'var(--ink)' }}>{expectedWins.toFixed(1)}</strong> wins
        of {totalWeeks}, with {(playoffPct * 100).toFixed(0)}% of simulated seasons reaching the
        playoffs. The width of this distribution is the honest answer to how much your season is
        already decided — and at this point, it isn&apos;t.
      </p>
    </div>
  );
};
