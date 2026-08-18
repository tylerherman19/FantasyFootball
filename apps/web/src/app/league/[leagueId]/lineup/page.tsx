import { SLOT_ELIGIBILITY, type LineupSlot, type Position } from '@ffe/core';
import { LeagueNav } from '@/components/LeagueNav';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { rosterWithLineup } from '@/lib/analysis';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

const POSITION_COLOR: Record<string, string> = {
  QB: 'var(--pos-qb)',
  RB: 'var(--pos-rb)',
  WR: 'var(--pos-wr)',
  TE: 'var(--pos-te)',
  K: 'var(--pos-k)',
  DEF: 'var(--pos-def)',
};

export default async function LineupPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);
  const { snapshot, myTeamId } = view;

  const players = await loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw);
  const roster = myTeamId === null ? [] : rosterWithLineup(view, myTeamId, players);

  const starters = roster.filter((entry) => entry.starting);
  const bench = roster.filter((entry) => !entry.starting);
  const projectedTotal = starters.reduce((sum, entry) => sum + entry.mean, 0);

  /**
   * The closest genuine decision.
   *
   * A decision only exists between players who could occupy the same slot —
   * comparing a quarterback to a tight end is not a lineup call, it is a
   * category error. So each starter is matched against the best benched player
   * eligible for that starter's slot, and the tightest of those gaps wins.
   */
  const closeCall = starters
    .flatMap((starter) => {
      if (starter.slot === null) return [];
      const eligible = SLOT_ELIGIBILITY[starter.slot as LineupSlot];
      if (eligible === null || eligible === undefined) return [];

      const challenger = bench.find((entry) => eligible.includes(entry.position as Position));
      if (challenger === undefined) return [];

      return [{ starter, challenger, gap: starter.mean - challenger.mean }];
    })
    .filter((option) => option.gap >= 0)
    .sort((a, b) => a.gap - b.gap)
    .find((option) => option.gap < 2) ?? null;

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="lineup"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-5xl px-6 pb-20">
        <div className="mb-8 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Week {snapshot.asOfWeek} projected total
            </div>
            <div className="tabular text-3xl font-semibold">{projectedTotal.toFixed(1)}</div>
          </div>
          <p className="max-w-md text-sm" style={{ color: 'var(--ink-muted)' }}>
            The optimal lineup, solved rather than sorted — in superflex that means starting two
            quarterbacks when the arithmetic says so, which greedy ordering gets wrong.
          </p>
        </div>

        {roster.length === 0 && (
          <p style={{ color: 'var(--ink-muted)' }}>
            No roster found — the league may not be drafted yet.
          </p>
        )}

        {closeCall !== null && (
          <div
            className="mb-8 rounded border p-4 text-sm"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
          >
            <strong>Closest call: {closeCall.starter.slot}.</strong> {closeCall.starter.name} (
            {closeCall.starter.mean.toFixed(1)}) over {closeCall.challenger.name} (
            {closeCall.challenger.mean.toFixed(1)}) — a gap of {closeCall.gap.toFixed(1)}, which is
            inside the projection&apos;s own error. Start either and stop deliberating.
          </div>
        )}

        {starters.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Starters
            </h2>
            <LineupTable entries={starters} showSlot />
          </section>
        )}

        {bench.length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Bench
            </h2>
            <LineupTable entries={bench} showSlot={false} />
          </section>
        )}
      </main>
    </>
  );
}

const LineupTable = ({
  entries,
  showSlot,
}: {
  entries: readonly Awaited<ReturnType<typeof rosterWithLineup>>[number][];
  showSlot: boolean;
}) => (
  <div className="scroll-x">
    <table className="w-full min-w-[30rem] text-left">
      <thead>
        <tr className="border-b text-xs uppercase tracking-widest"
          style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}>
          {showSlot && <th className="py-2 pr-3">Slot</th>}
          <th className="py-2">Player</th>
          <th className="py-2">Team</th>
          <th className="py-2 text-right">Proj.</th>
          <th className="py-2 text-right">Range</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.playerId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
            {showSlot && (
              <td className="py-2.5 pr-3 text-xs font-semibold" style={{ color: 'var(--ink-faint)' }}>
                {entry.slot}
              </td>
            )}
            <td className="py-2.5">
              <span className="font-medium">{entry.name}</span>
              <span
                className="ml-2 text-[10px] font-semibold uppercase"
                style={{ color: POSITION_COLOR[entry.position] ?? 'var(--ink-faint)' }}
              >
                {entry.position}
              </span>
            </td>
            <td className="py-2.5 text-sm" style={{ color: 'var(--ink-muted)' }}>
              {entry.team}
            </td>
            <td className="tabular py-2.5 text-right font-medium">
              {entry.projected ? entry.mean.toFixed(1) : '—'}
            </td>
            <td className="tabular py-2.5 text-right text-sm" style={{ color: 'var(--ink-faint)' }}>
              {entry.projected
                ? `${Math.max(0, entry.mean - entry.sd).toFixed(0)}–${(entry.mean + entry.sd).toFixed(0)}`
                : 'not projected'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
