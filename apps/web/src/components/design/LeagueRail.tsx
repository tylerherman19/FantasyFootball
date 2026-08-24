import Link from 'next/link';
import type { ReactNode } from 'react';
import { RailBlock, RailStat } from './DrillRail';
import type { LeagueView } from '@/lib/league-data';

/**
 * The context every league page owes its reader.
 *
 * Eight pages needed a rail and writing eight bespoke ones would have produced
 * eight slightly different accounts of the same model — which is the exact
 * failure the design system exists to prevent. This is the shared part: how the
 * numbers were produced, what the model is, and what it measured and refused to
 * ship. Pages add their own blocks above it.
 *
 * The declined-rungs block is on every page on purpose. A product that only
 * shows what it shipped is telling you half of what it knows, and "opponent
 * strength does not move a projection, measured twice" is the most useful thing
 * this model found — it is the reason the scheme page is a description rather
 * than an adjustment.
 */
export const LeagueRail = ({
  view,
  children,
}: {
  readonly view: LeagueView;
  /** Page-specific context, rendered above the shared blocks. */
  readonly children?: ReactNode;
}) => {
  const { result, snapshot } = view;
  const me = view.myTeamId === null ? null : result.teams.find((t) => t.teamId === view.myTeamId);

  return (
    <>
      {children}

      {me !== undefined && me !== null && (
        <RailBlock
          title="Where you stand"
          note="Playoff odds mostly follow wins. Title odds follow how good the roster is. A big gap between them is a team that gets to the playoffs and then loses in them."
        >
          <RailStat label="Title" value={`${(me.titlePct * 100).toFixed(1)}%`} />
          <RailStat label="Playoffs" value={`${(me.playoffPct * 100).toFixed(0)}%`} />
          <RailStat label="Projected wins" value={me.expectedWins.toFixed(1)} />
        </RailBlock>
      )}

      <RailBlock
        title="How this was computed"
        note="Every percentage on this page comes out of the same set of simulated seasons, so the playoff odds and the title odds are always telling the same story."
      >
        <RailStat
          label="Simulated seasons"
          value={result.iterations.toLocaleString()}
          hint="Each plays every remaining week, solves each manager's optimal lineup, and runs the bracket."
        />
        <RailStat
          label="Model"
          value={view.modelVersion ?? 'none'}
          hint="Opportunity x efficiency with empirical-Bayes shrinkage, plus a draft-capital rookie prior."
        />
        <RailStat
          label="Out-of-sample skill"
          value="+5.6%"
          hint="MAE against a Marcel baseline over 21,679 player-weeks, 2022-2025. Wins all four seasons separately."
        />
        <RailStat
          label="Scoring"
          value={snapshot.league.format}
          hint="Points are derived per league from projected stat lines, never baked into the model."
        />
      </RailBlock>

      <RailBlock
        title="What the model declined"
        note="Things this model tried, measured, and threw out — kept visible because most tools quietly do all three of these."
      >
        <p className="mb-2">
          Opponent strength does not move a projection. Measured three times — against points
          allowed, against opportunity allowed, and finally against the spread rather than the mean
          — and it survived none of them.
        </p>
        <RailStat label="v2 matchup" value="declined" hint="MAE 4.564 against v1's 4.568, worsening monotonically with weight." />
        <RailStat label="v3 allocation" value="declined" hint="MAE 4.567 against 4.568. Same shape of failure." />
        <RailStat
          label="Scheme on spread"
          value="declined"
          hint="WR 0.997 against RB 1.005 — the two should have moved apart and moved together instead. 21,679 player-weeks."
        />

        <p className="mt-3">
          <Link href="/model" className="underline" style={{ color: 'var(--ink-muted)' }}>
            How the model works
          </Link>
        </p>
      </RailBlock>
    </>
  );
};
