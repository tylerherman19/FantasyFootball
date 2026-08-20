/**
 * Where the season can land.
 *
 * A single "7.0 projected wins" hides the thing that actually matters — the
 * spread. A team projected at 7 wins with a tight distribution is a different
 * proposition from one that ranges 3 to 11, even though the headline number is
 * identical, and the second is far more likely to either make a run or collapse.
 *
 * Drawn as bars over final win totals with the middle 80% of outcomes shaded,
 * so "how wide is my range, and where does it sit" is answerable by looking
 * rather than by reading the caption.
 */

/** Win totals bracketing the central `mass` of the distribution. */
const centralInterval = (
  distribution: readonly number[],
  mass: number,
): { low: number; high: number } => {
  const tail = (1 - mass) / 2;

  let cumulative = 0;
  let low = 0;
  let high = distribution.length - 1;

  for (let wins = 0; wins < distribution.length; wins += 1) {
    cumulative += distribution[wins] ?? 0;
    if (cumulative >= tail) {
      low = wins;
      break;
    }
  }

  cumulative = 0;
  for (let wins = distribution.length - 1; wins >= 0; wins -= 1) {
    cumulative += distribution[wins] ?? 0;
    if (cumulative >= tail) {
      high = wins;
      break;
    }
  }

  return { low, high: Math.max(low, high) };
};

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
  const { low, high } = centralInterval(winDistribution, 0.8);

  const modeWins = winDistribution.reduce(
    (best, share, wins) => (share > (winDistribution[best] ?? 0) ? wins : best),
    0,
  );

  const HEIGHT = 120;

  return (
    <figure className="m-0">
      <div className="relative" style={{ height: HEIGHT }}>
        {/*
         * One faint reference line at the top of the plot. More gridlines than
         * this on a distribution adds ink without adding readings — the shape
         * is the message, not the exact height of any single bar.
         */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 border-t"
          style={{ borderColor: 'var(--rule)' }}
        />

        <div className="flex h-full items-end gap-[3px]">
          {winDistribution.map((share, wins) => {
            const height = share > 0 ? Math.max(2, (share / max) * (HEIGHT - 18)) : 0;
            const inRange = wins >= low && wins <= high;

            return (
              <div
                key={wins}
                className="group relative flex flex-1 flex-col items-center justify-end"
              >
                {wins === modeWins && (
                  <span
                    className="tabular mb-1 text-[10px] font-semibold"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    {(share * 100).toFixed(0)}%
                  </span>
                )}

                <div
                  style={{
                    height,
                    width: '100%',
                    /*
                     * One hue, two steps. Outcomes inside the central 80% are
                     * the full step; the tails are the same hue held back,
                     * which reads as "less likely" without introducing a second
                     * colour that would imply a second category.
                     */
                    background: inRange ? 'var(--p-5)' : 'var(--p-2)',
                    borderRadius: '2px 2px 0 0',
                  }}
                />

                {/* Hover layer: every bar readable, no permanent labels. */}
                <div
                  className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap border px-1.5 py-1 text-[11px] group-hover:block"
                  style={{
                    borderColor: 'var(--rule-strong)',
                    background: 'var(--surface)',
                    color: 'var(--ink)',
                  }}
                >
                  <strong>{wins}</strong> wins · {(share * 100).toFixed(1)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-1 flex gap-[3px]">
        {winDistribution.map((_, wins) => (
          <div
            key={wins}
            className="tabular flex-1 text-center text-[10px]"
            style={{
              color: wins === modeWins ? 'var(--ink)' : 'var(--ink-faint)',
              fontWeight: wins === modeWins ? 600 : 400,
            }}
          >
            {wins}
          </div>
        ))}
      </div>

      <figcaption className="mt-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
        Centred on <strong style={{ color: 'var(--ink)' }}>{expectedWins.toFixed(1)}</strong> wins of{' '}
        {totalWeeks}, with four seasons in five landing between{' '}
        <strong style={{ color: 'var(--ink)' }}>{low}</strong> and{' '}
        <strong style={{ color: 'var(--ink)' }}>{high}</strong>, and{' '}
        <strong style={{ color: 'var(--ink)' }}>{(playoffPct * 100).toFixed(0)}%</strong> reaching
        the playoffs. That width is the honest answer to how much of your season is already decided.
      </figcaption>

      {/* Identity is never carried by colour alone, so the shading is named. */}
      <p className="mt-1.5 flex items-center gap-3 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3" style={{ background: 'var(--p-5)' }} /> middle 80%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3" style={{ background: 'var(--p-2)' }} /> tails
        </span>
      </p>
    </figure>
  );
};
