import type { TeamStrength } from '@/lib/positional-strength';

/**
 * The conclusion, in words, before any chart.
 *
 * A distribution and a table of odds are evidence. They are not a finding, and
 * a reader should not have to derive one — the most common failure of a data
 * page is showing everything and concluding nothing, which leaves the work of
 * interpretation to the person least equipped to do it.
 *
 * So this reads the same numbers the charts are drawn from and says what they
 * amount to: where the season stands, what is actually wrong with the roster,
 * and the one move that follows. Every clause is derived, never templated — if
 * the roster has no weak position, it says so rather than inventing one.
 */

export interface TakeawayInput {
  readonly teamName: string;
  readonly rank: number;
  readonly teamCount: number;
  readonly playoffPct: number;
  readonly titlePct: number;
  readonly expectedWins: number;
  readonly regularSeasonWeeks: number;
  readonly strength: TeamStrength | null;
  /** True when no roster in the league has a player yet. */
  readonly undrafted: boolean;
}

/** Contending, in the middle, or selling — decided by playoff odds. */
const stance = (playoffPct: number): { verdict: string; advice: string } => {
  if (playoffPct >= 0.7) {
    return {
      verdict: 'a contender',
      advice:
        'The season is worth buying into: a move that raises this year’s ceiling is worth more than a pick that pays in two.',
    };
  }
  if (playoffPct >= 0.4) {
    return {
      verdict: 'on the bubble',
      advice:
        'This is the position with the most to gain from a decision and the most to lose from drift — the middle is the one place where doing nothing is usually wrong.',
    };
  }
  return {
    verdict: 'a long shot',
    advice:
      'Selling an ageing starter for youth or picks costs little here, because the wins it costs are wins that were not going to matter.',
  };
};

export const Takeaway = ({ input }: { readonly input: TakeawayInput }) => {
  if (input.undrafted) {
    return (
      <div
        className="mb-6 border-l-2 px-4 py-3"
        style={{ borderColor: 'var(--accent)', background: 'var(--surface-sunk)' }}
      >
        <p className="text-sm">
          <strong>This league hasn’t drafted.</strong>{' '}
          <span style={{ color: 'var(--ink-muted)' }}>
            Every roster is empty, so there is nothing yet to project, trade or claim. The analysis
            below fills in once picks are made.
          </span>
        </p>
      </div>
    );
  }

  const { verdict, advice } = stance(input.playoffPct);

  // The weakest and strongest positions, by rank within this league — which is
  // the comparison that decides whether a hole is worth trading to fix.
  const cells = input.strength === null ? [] : [...input.strength.cells];
  const weakest = cells.length === 0 ? null : cells.reduce((a, b) => (a.rank > b.rank ? a : b));
  const strongest = cells.length === 0 ? null : cells.reduce((a, b) => (a.rank < b.rank ? a : b));

  /*
   * Only call a position a weakness if it is genuinely bottom-third, and only
   * name a trade if there is a surplus to pay with. A page that manufactures a
   * recommendation for a balanced roster is worse than one that stays quiet.
   */
  const hasHole = weakest !== null && weakest.rank > input.teamCount * 0.66;
  const hasSurplus = strongest !== null && strongest.rank <= Math.max(2, input.teamCount * 0.34);

  return (
    <div
      className="mb-6 border-l-2 px-4 py-3"
      style={{ borderColor: 'var(--accent)', background: 'var(--surface-sunk)' }}
    >
      <p className="text-sm leading-relaxed">
        <strong>
          {input.teamName} projects {input.rank === 1 ? '1st' : `${input.rank}th`} of{' '}
          {input.teamCount} — {verdict}.
        </strong>{' '}
        <span style={{ color: 'var(--ink-muted)' }}>
          {(input.playoffPct * 100).toFixed(0)}% to make the playoffs and{' '}
          {(input.titlePct * 100).toFixed(1)}% to win it, on {input.expectedWins.toFixed(1)} wins of{' '}
          {input.regularSeasonWeeks}. {advice}
        </span>
      </p>

      {hasHole && weakest !== null && (
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          <strong style={{ color: 'var(--ink)' }}>
            {weakest.position} is the hole: {weakest.rank} of {input.teamCount} in the league.
          </strong>{' '}
          {hasSurplus && strongest !== null && strongest.position !== weakest.position ? (
            <>
              You are {strongest.rank === 1 ? '1st' : `${strongest.rank}th`} at{' '}
              {strongest.position}, which is what you have to pay with — a {strongest.position} for{' '}
              {weakest.position} trade is the shape to look for, and the trade page will price one.
            </>
          ) : (
            <>
              Nothing on this roster is deep enough to trade from comfortably, so the wire is the
              cheaper route.
            </>
          )}
        </p>
      )}

      {!hasHole && cells.length > 0 && (
        <p className="mt-2 text-sm" style={{ color: 'var(--ink-muted)' }}>
          No position is a genuine weakness — this roster is balanced, which means the gains left
          are in start/sit and the wire rather than in a trade.
        </p>
      )}
    </div>
  );
};
