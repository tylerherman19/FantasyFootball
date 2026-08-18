import { LeagueNav } from '@/components/LeagueNav';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { rosterWithLineup } from '@/lib/analysis';
import { leagueRankings } from '@/lib/rankings';
import type { Position } from '@ffe/core';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

export default async function RosterPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);
  const { snapshot, myTeamId } = view;

  const players = await loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw);
  const roster = myTeamId === null ? [] : rosterWithLineup(view, myTeamId, players);

  // Replacement level comes from the shared metric, which seats the league's
  // flex slots against the real player pool. The version this page used to carry
  // keyed demand by slot name, so FLEX and SUPER_FLEX matched no position and
  // their demand vanished — which set replacement level too high and made every
  // roster look thinner than it is.
  const { replacement: levels } = await leagueRankings(view, players);

  const unprojected = roster.filter((entry) => !entry.projected);

  const byPosition = new Map<string, typeof roster>();
  for (const entry of roster.filter((entry) => entry.projected)) {
    const bucket = byPosition.get(entry.position) ?? [];
    bucket.push(entry);
    byPosition.set(entry.position, bucket);
  }

  const groups = [...byPosition.entries()].sort((a, b) => {
    const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];
    return order.indexOf(a[0]) - order.indexOf(b[0]);
  });

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="roster"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-5xl px-6 pb-20">
        <p className="mb-8 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          Value over replacement is measured against the best player <em>not</em> starting anywhere
          in <em>this</em> league — the man you would pick up if you lost a starter — rather than a
          generic baseline. A receiver who starts easily in a shallow league is a bench piece in a
          deep one, and flex slots move that line further than most tools admit.
        </p>

        {roster.length === 0 && <p style={{ color: 'var(--ink-muted)' }}>No roster found.</p>}

        <div className="space-y-8">
          {groups.map(([position, entries]) => {
            const replacement = levels.get(position as Position) ?? 0;
            const surplus = entries.reduce((sum, e) => sum + Math.max(0, e.mean - replacement), 0);

            return (
              <section key={position}>
                <div className="mb-2 flex items-baseline justify-between border-b pb-1" style={{ borderColor: 'var(--rule-strong)' }}>
                  <h2 className="text-sm font-semibold uppercase tracking-widest">{position}</h2>
                  <span className="tabular text-xs" style={{ color: 'var(--ink-faint)' }}>
                    replacement {replacement.toFixed(1)} · surplus {surplus.toFixed(1)}
                  </span>
                </div>

                <ul>
                  {entries.map((entry) => {
                    const over = entry.mean - replacement;
                    return (
                      <li
                        key={entry.playerId}
                        className="flex items-center justify-between gap-4 border-b py-2"
                        style={{ borderColor: 'var(--rule)' }}
                      >
                        <span>
                          <span className="font-medium">{entry.name}</span>
                          <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                            {entry.team}
                            {entry.starting && ' · starting'}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-baseline gap-4">
                          <span className="tabular text-sm" style={{ color: 'var(--ink-muted)' }}>
                            {entry.mean.toFixed(1)}
                          </span>
                          <span
                            className="tabular w-16 text-right text-sm font-medium"
                            style={{ color: over >= 0 ? 'var(--good)' : 'var(--bad)' }}
                          >
                            {over >= 0 ? '+' : ''}
                            {over.toFixed(1)}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>

        {unprojected.length > 0 && (
          <section className="mt-10">
            <div className="mb-2 border-b pb-1" style={{ borderColor: 'var(--rule-strong)' }}>
              <h2 className="text-sm font-semibold uppercase tracking-widest">Not projected</h2>
            </div>
            <p className="mb-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
              These players are on your roster but have no projection yet — 2026 rookies with no NFL
              snaps to learn from, and positions the model does not cover. They are listed rather
              than hidden, because a silent zero looks like a bad player.
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" style={{ color: 'var(--ink-muted)' }}>
              {unprojected.map((entry) => (
                <li key={entry.playerId}>
                  {entry.name}
                  <span className="ml-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                    {entry.position}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
