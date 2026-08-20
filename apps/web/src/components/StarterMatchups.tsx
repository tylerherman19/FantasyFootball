import type { MatchupEffect } from '@/lib/defense';

/**
 * The scheme read, next to the start/sit decision it bears on.
 *
 * These numbers already existed on their own page, which is the wrong place for
 * them: nobody opens a scheme tab and then walks back to the lineup holding six
 * facts in their head. A matchup is only worth measuring where the decision is
 * made, so it sits beside the player, with the projection and its range.
 *
 * The claim is shown rather than a grade. "28th in pressure rate" is auditable
 * and arguable; a matchup score out of ten is a vibe with a colour, and a
 * manager who disagrees with it has nothing to disagree with.
 */

export interface StarterMatchup {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly opponent: string | null;
  readonly projected: number;
  readonly sd: number;
  readonly effect: MatchupEffect | null;
}

const POSITION_COLOR: Record<string, string> = {
  QB: 'var(--pos-qb)',
  RB: 'var(--pos-rb)',
  WR: 'var(--pos-wr)',
  TE: 'var(--pos-te)',
  K: 'var(--pos-k)',
  DEF: 'var(--pos-def)',
};

/** Favourable, hostile, or neither — with a word, never colour alone. */
const verdict = (score: number): { label: string; color: string } => {
  if (score >= 0.25) return { label: 'favourable', color: 'var(--good)' };
  if (score <= -0.25) return { label: 'hostile', color: 'var(--bad)' };
  return { label: 'neutral', color: 'var(--ink-faint)' };
};

export const StarterMatchups = ({ rows }: { readonly rows: readonly StarterMatchup[] }) => {
  if (rows.length === 0) return null;

  // A shared scale so the ranges are comparable down the column.
  const scale = Math.max(1, ...rows.map((row) => row.projected + 1.2816 * row.sd));

  return (
    <div className="mt-2 grid gap-2">
      {rows.map((row) => {
        const { label, color } = verdict(row.effect?.score ?? 0);
        const low = Math.max(0, row.projected - 1.2816 * row.sd);
        const high = row.projected + 1.2816 * row.sd;
        const pct = (value: number) => `${Math.min(100, (value / scale) * 100)}%`;

        return (
          <article
            key={row.playerId}
            className="border-l-2 py-1.5 pl-3"
            style={{ borderColor: POSITION_COLOR[row.position] ?? 'var(--rule)' }}
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
                style={{ background: POSITION_COLOR[row.position] ?? 'var(--ink-faint)' }}
              >
                {row.position}
              </span>
              <span className="text-sm font-semibold">{row.name}</span>
              {row.opponent !== null && (
                <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  vs {row.opponent}
                </span>
              )}
              <span className="text-[11px] font-semibold" style={{ color }}>
                {label}
              </span>

              <span className="tabular ml-auto text-sm font-semibold">
                {row.projected.toFixed(1)}
              </span>
              <span className="tabular text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                ±{(1.2816 * row.sd).toFixed(1)}
              </span>
            </div>

            {/*
             * The range, not just the point. A projection printed alone reads as
             * a promise; the band says what it actually is — the middle of a
             * distribution, and a wider one for some players than others.
             */}
            <div
              className="relative mt-1 h-3 max-w-sm"
              title={`80% of outcomes between ${low.toFixed(1)} and ${high.toFixed(1)}`}
            >
              <div
                className="absolute top-1/2 h-1 -translate-y-1/2 rounded-sm"
                style={{ left: pct(low), width: pct(high - low), background: 'var(--p-low)' }}
              />
              <div
                className="absolute top-1/2 h-3 w-[2px] -translate-y-1/2"
                style={{ left: pct(row.projected), background: 'var(--ink)' }}
              />
            </div>

            {row.effect !== null && (
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                <span className="font-semibold" style={{ color: 'var(--ink)' }}>
                  {row.effect.headline}.
                </span>{' '}
                {row.effect.detail}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
};
