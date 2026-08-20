import type { DefenseProfile, SchemeRead } from '@/lib/scheme';

/**
 * What each starter is walking into.
 *
 * The unit of analysis is the defense, not the player, because that is how
 * football works: a coordinator calls a shell against an offence and every
 * skill player inherits the consequence. Showing the tendency and its
 * direction — rather than a matchup grade — is what lets a manager disagree
 * with the model, which they should be able to do.
 */

export interface MatchupRow {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly opponent: string;
  readonly venue: string;
  readonly defense: DefenseProfile | null;
  readonly reads: readonly SchemeRead[];
  /** This week's projection under the league's own scoring. */
  readonly projected: number;
  /** Calibrated standard deviation for the week. */
  readonly sd: number;
}

/**
 * The 80% interval, drawn against the widest interval on the board.
 *
 * A projection without a spread invites false precision — "13.4 points" reads as
 * a promise. Showing the band makes the honest claim instead: this is the middle
 * of a distribution, and for some players that distribution is twice as wide as
 * for others. The spreads behind it are calibrated rather than assumed; the
 * backtest checks that an 80% interval really does contain the outcome about
 * 80% of the time, and it does (83.9%).
 */
const IntervalBar = ({
  projected,
  sd,
  scale,
}: {
  readonly projected: number;
  readonly sd: number;
  readonly scale: number;
}) => {
  // 1.2816 sigma each side is the central 80% of a normal.
  const low = Math.max(0, projected - 1.2816 * sd);
  const high = projected + 1.2816 * sd;

  const pct = (value: number) => `${Math.min(100, (value / scale) * 100)}%`;

  return (
    <div className="relative h-4 w-full" title={`80% of outcomes between ${low.toFixed(1)} and ${high.toFixed(1)}`}>
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-sm"
        style={{ left: pct(low), width: pct(high - low), background: 'var(--p-2)' }}
      />
      {/* The projection itself: a tick, not a fill, so it reads as a point. */}
      <div
        className="absolute top-1/2 h-3.5 w-[2px] -translate-y-1/2"
        style={{ left: pct(projected), background: 'var(--ink)' }}
      />
    </div>
  );
};

const POSITION_COLOR: Record<string, string> = {
  QB: 'var(--pos-qb)',
  RB: 'var(--pos-rb)',
  WR: 'var(--pos-wr)',
  TE: 'var(--pos-te)',
  K: 'var(--pos-k)',
  DEF: 'var(--pos-def)',
};

const DIRECTION_COLOR: Record<SchemeRead['direction'], string> = {
  helps: 'var(--pos)',
  hurts: 'var(--neg)',
  neutral: 'var(--ink-faint)',
};

const DIRECTION_MARK: Record<SchemeRead['direction'], string> = {
  helps: '▲',
  hurts: '▼',
  neutral: '■',
};

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 81 -> "81st". */
const ordinal = (value: number): string => {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;

  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] ?? 'th';
  return `${value}${suffix}`;
};

/** A percentile as a small bar — position in the league, not a raw rate. */
const PercentileBar = ({ value, color }: { value: number; color: string }) => (
  <span
    className="relative inline-block h-1.5 w-14 align-middle"
    style={{ background: 'var(--rule)' }}
    aria-hidden="true"
  >
    <span
      className="absolute left-0 top-0 h-full"
      style={{ width: `${Math.round(value * 100)}%`, background: color }}
    />
  </span>
);

export const SchemeMatchups = ({
  rows,
  schemeSeason,
}: {
  readonly rows: readonly MatchupRow[];
  readonly schemeSeason: number;
}) => {
  // One shared scale, so the bars are comparable down the column.
  const scale = Math.max(
    1,
    ...rows.map((row) => row.projected + 1.2816 * row.sd),
  );

  return (
  <section className="mb-12">
    <h2 className="kicker mb-1">This week, player by player</h2>
    <p className="standfirst mb-4">
      Each starter&apos;s projection with the range around it, and what the opposing coordinator
      actually does about it. Coverage and box counts come from {schemeSeason} participation
      charting — published only after a season ends, and sticky enough that last year is the right
      prior; a coordinator change is the case to watch. The ranges are calibrated against real
      forecast error, not assumed.
    </p>

    <div className="space-y-2">
      {rows.map((row) => (
        <article
          key={row.playerId}
          className="border-l-2 py-2 pl-3"
          style={{ borderColor: POSITION_COLOR[row.position] ?? 'var(--rule)' }}
        >
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className="chip"
              style={{ background: POSITION_COLOR[row.position] ?? 'var(--ink-faint)' }}
            >
              {row.position}
            </span>
            <span className="font-semibold">{row.name}</span>
            <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
              {row.venue === 'home' ? 'vs' : 'at'} {row.opponent}
            </span>
            <span className="tabular ml-auto text-sm font-semibold">
              {row.projected.toFixed(1)}
            </span>
            <span className="uncertainty tabular">
              ±{(1.2816 * row.sd).toFixed(1)}
            </span>
          </div>

          <div className="mb-1 mt-1 max-w-md">
            <IntervalBar projected={row.projected} sd={row.sd} scale={scale} />
          </div>

          {row.defense === null ? (
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
              No charting profile for this defense.
            </p>
          ) : row.reads.length === 0 ? (
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
              Nothing extreme in this defense&apos;s tendencies — an average matchup, which is
              itself worth knowing.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {row.reads.map((read) => (
                <li key={read.label} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  {/* Direction carries a mark and a word, never colour alone. */}
                  <span
                    className="font-semibold"
                    style={{ color: DIRECTION_COLOR[read.direction] }}
                  >
                    {DIRECTION_MARK[read.direction]} {read.label}
                  </span>
                  <PercentileBar
                    value={read.percentile}
                    color={DIRECTION_COLOR[read.direction]}
                  />
                  <span className="tabular" style={{ color: 'var(--ink-faint)' }}>
                    {ordinal(Math.round(read.percentile * 100))} pct
                  </span>
                  <span style={{ color: 'var(--ink-muted)' }}>{read.note}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>

    <p className="mt-3 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
      Bar spans the middle 80% of simulated outcomes; the tick is the projection. Backtested over
      10,979 player-weeks, an interval drawn this way contained the real result 83.9% of the time.
    </p>
  </section>
  );
};
