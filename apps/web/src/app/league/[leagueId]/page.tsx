import { OddsBar } from '@/components/OddsBar';
import { PositionalHeatmap } from '@/components/PositionalHeatmap';
import { OutcomeDistribution } from '@/components/OutcomeDistribution';
import { StatTile } from '@/components/StatTile';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { remainingSchedule, weekLeverage } from '@/lib/analysis';
import { positionalStrength } from '@/lib/positional-strength';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

export default async function OutlookPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);
  const { snapshot, result, teamNames, myTeamId } = view;
  const isGuillotine = snapshot.league.format === 'guillotine';

  const rosteredPlayers = snapshot.rosters.reduce((sum, r) => sum + r.playerIds.length, 0);
  const notDrafted = rosteredPlayers === 0;

  const standings = [...result.teams].sort((a, b) =>
    isGuillotine
      ? b.titlePct - a.titlePct
      : b.playoffPct - a.playoffPct || b.expectedWins - a.expectedWins,
  );

  const me = myTeamId === null ? null : result.teams.find((t) => t.teamId === myTeamId) ?? null;
  const myRank = me === null ? null : standings.findIndex((t) => t.teamId === me.teamId) + 1;
  const myRecord = myTeamId === null ? null : snapshot.records.find((r) => r.teamId === myTeamId) ?? null;

  const schedule = !notDrafted && myTeamId !== null && !isGuillotine ? remainingSchedule(view, myTeamId) : [];
  const leverage = !notDrafted && myTeamId !== null && !isGuillotine
    ? weekLeverage(view, myTeamId, snapshot.asOfWeek)
    : [];

  return (
    <>

      <>
        {notDrafted && (
          <div
            className="mb-8 rounded border p-4 text-sm"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
          >
            <strong>Not drafted yet.</strong> Every roster is empty, so there is nothing to simulate.
            This page becomes meaningful the moment the draft happens.
          </div>
        )}

        {me !== null && !notDrafted && (
          <section className="mb-10">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Your season
            </h2>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded border sm:grid-cols-4"
              style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}>
              <StatTile label="Projected rank" value={`#${myRank} of ${standings.length}`} />
              <StatTile
                label="Projected record"
                value={`${me.expectedWins.toFixed(1)}-${(snapshot.league.regularSeasonWeeks - me.expectedWins).toFixed(1)}`}
                sub={myRecord === null ? undefined : `now ${myRecord.wins}-${myRecord.losses}`}
              />
              <StatTile
                label={isGuillotine ? 'Survive to end' : 'Playoffs'}
                value={`${((isGuillotine ? me.titlePct : me.playoffPct) * 100).toFixed(0)}%`}
                emphasis
              />
              <StatTile label="Title" value={`${(me.titlePct * 100).toFixed(1)}%`} emphasis />
            </div>
          </section>
        )}

        {me !== null && !notDrafted && !isGuillotine && me.winDistribution.length > 1 && (
          <section className="mb-10">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Where your season can land
            </h2>
            <p className="mb-3 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
              Every simulated season, by final win total. The spread matters as much as the average.
            </p>
            <OutcomeDistribution
              winDistribution={me.winDistribution}
              expectedWins={me.expectedWins}
              playoffPct={me.playoffPct}
            />
          </section>
        )}

        <section className="mb-10">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
            League outlook
          </h2>
          <div className="scroll-x">
            <table className="w-full min-w-[36rem] text-left">
              <thead>
                <tr className="border-b text-xs uppercase tracking-widest"
                  style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}>
                  <th className="py-2">#</th>
                  <th className="py-2">Team</th>
                  <th className="py-2 text-right">Proj. wins</th>
                  <th className="py-2 pl-6">{isGuillotine ? 'Survives' : 'Playoffs'}</th>
                  <th className="py-2 pl-6 text-right">Title</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((team, index) => {
                  const isMine = team.teamId === myTeamId;
                  return (
                    <tr key={team.teamId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                      <td className="tabular py-3 pr-2 text-sm" style={{ color: 'var(--ink-faint)' }}>
                        {index + 1}
                      </td>
                      <td className="py-3" style={{ fontWeight: isMine ? 600 : 400 }}>
                        {teamNames.get(team.teamId) ?? team.teamId}
                        {isMine && (
                          <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest"
                            style={{ background: 'var(--surface-sunk)', color: 'var(--accent)' }}>
                            you
                          </span>
                        )}
                      </td>
                      <td className="tabular py-3 text-right">{team.expectedWins.toFixed(1)}</td>
                      <td className="py-3 pl-6">
                        <OddsBar
                          probability={isGuillotine ? team.titlePct : team.playoffPct}
                          iterations={result.iterations}
                        />
                      </td>
                      <td className="tabular py-3 pl-6 text-right">{(team.titlePct * 100).toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {schedule.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Your remaining schedule
            </h2>
            <p className="mb-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
              Win probability from projected totals and their spread, not from record.
            </p>
            <div className="scroll-x">
              <div className="flex gap-2 pb-2">
                {schedule.map((game) => (
                  <div
                    key={game.matchupId}
                    className="min-w-[8.5rem] shrink-0 rounded border p-3"
                    style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
                  >
                    <div className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
                      Week {game.week}
                    </div>
                    <div className="mt-1 truncate text-sm" style={{ color: 'var(--ink-muted)' }}>
                      vs {game.opponentName}
                    </div>
                    <div
                      className="tabular mt-2 text-xl font-semibold"
                      style={{
                        color:
                          game.winProbability >= 0.6
                            ? 'var(--pos)'
                            : game.winProbability <= 0.4
                              ? 'var(--neg)'
                              : 'var(--ink)',
                      }}
                    >
                      {(game.winProbability * 100).toFixed(0)}%
                    </div>
                    <div className="tabular mt-1 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                      {game.projectedFor.toFixed(0)} – {game.projectedAgainst.toFixed(0)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {leverage.length > 0 && (
          <section>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              What to root for, week {snapshot.asOfWeek}
            </h2>
            <p className="mb-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
              Every game this week replayed both ways. The swing is what the result is worth to your
              playoff odds.
            </p>
            <ul className="divide-y rounded border" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
              {leverage.map((item) => (
                <li key={item.matchupId} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm">{item.description}</span>
                  <span className="tabular shrink-0 text-sm font-semibold" style={{ color: 'var(--accent)' }}>
                    ±{(item.swing * 100).toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <PositionalHeatmap
          strengths={positionalStrength(view)}
          teamNames={view.teamNames}
          myTeamId={view.myTeamId}
        />
      </>
    </>
  );
}
