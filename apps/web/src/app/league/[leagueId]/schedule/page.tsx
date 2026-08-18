import { LeagueNav } from '@/components/LeagueNav';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { remainingSchedule, teamWeekStrength, winProbability } from '@/lib/analysis';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

export default async function SchedulePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);
  const { snapshot, myTeamId, teamNames } = view;

  const isGuillotine = snapshot.league.format === 'guillotine';
  const mySchedule = myTeamId === null || isGuillotine ? [] : remainingSchedule(view, myTeamId);

  /**
   * Strength of remaining schedule, per team.
   *
   * Averaging opponents' win probability against a common yardstick — each
   * team's own projected strength — makes schedules comparable. Two managers
   * with identical rosters can have very different seasons ahead, and this is
   * the number that says so.
   */
  const sosByTeam = snapshot.rosters
    .map((roster) => {
      const games = snapshot.schedule.filter(
        (m) => m.week >= snapshot.asOfWeek && m.teamIds.includes(roster.teamId),
      );
      if (games.length === 0) return null;

      const mine = teamWeekStrength(view, roster.teamId, snapshot.asOfWeek);
      const winChances = games.map((game) => {
        const opponentId = game.teamIds[0] === roster.teamId ? game.teamIds[1] : game.teamIds[0];
        return winProbability(mine, teamWeekStrength(view, opponentId, game.week));
      });

      return {
        teamId: roster.teamId,
        name: teamNames.get(roster.teamId) ?? roster.teamId,
        games: games.length,
        expectedWins: winChances.reduce((sum, p) => sum + p, 0),
        averageWinChance: winChances.reduce((sum, p) => sum + p, 0) / winChances.length,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.averageWinChance - a.averageWinChance);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="schedule"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-5xl px-6 pb-20">
        {isGuillotine && (
          <div className="mb-8 rounded border p-4 text-sm" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
            <strong>No schedule in a guillotine league.</strong> Nobody plays anybody — every team
            scores against the field and the lowest is eliminated. Survival odds live on the Outlook
            tab.
          </div>
        )}

        {mySchedule.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Your remaining games
            </h2>
            <div className="scroll-x">
              <table className="w-full min-w-[32rem] text-left">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-widest"
                    style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}>
                    <th className="py-2">Week</th>
                    <th className="py-2">Opponent</th>
                    <th className="py-2 text-right">You</th>
                    <th className="py-2 text-right">Them</th>
                    <th className="py-2 text-right">Win</th>
                  </tr>
                </thead>
                <tbody>
                  {mySchedule.map((game) => (
                    <tr key={game.matchupId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                      <td className="tabular py-2.5 text-sm" style={{ color: 'var(--ink-faint)' }}>
                        {game.week}
                      </td>
                      <td className="py-2.5">{game.opponentName}</td>
                      <td className="tabular py-2.5 text-right text-sm">{game.projectedFor.toFixed(1)}</td>
                      <td className="tabular py-2.5 text-right text-sm" style={{ color: 'var(--ink-muted)' }}>
                        {game.projectedAgainst.toFixed(1)}
                      </td>
                      <td
                        className="tabular py-2.5 text-right font-semibold"
                        style={{
                          color:
                            game.winProbability >= 0.6
                              ? 'var(--good)'
                              : game.winProbability <= 0.4
                                ? 'var(--bad)'
                                : 'var(--ink)',
                        }}
                      >
                        {(game.winProbability * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {sosByTeam.length > 0 && (
          <section>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Strength of remaining schedule
            </h2>
            <p className="mb-3 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
              Each team&apos;s average chance of winning its remaining games. Identical rosters can
              face very different seasons, and this is where that shows up.
            </p>
            <ul>
              {sosByTeam.map((row) => (
                <li
                  key={row.teamId}
                  className="flex items-center gap-4 border-b py-2"
                  style={{
                    borderColor: 'var(--rule)',
                    fontWeight: row.teamId === myTeamId ? 600 : 400,
                  }}
                >
                  <span className="flex-1 truncate">{row.name}</span>
                  <span className="h-2 w-40 shrink-0 overflow-hidden rounded" style={{ background: 'var(--rule)' }}>
                    <span
                      className="block h-full"
                      style={{
                        width: `${row.averageWinChance * 100}%`,
                        background: row.teamId === myTeamId ? 'var(--accent)' : 'var(--p-mid)',
                      }}
                    />
                  </span>
                  <span className="tabular w-14 shrink-0 text-right text-sm">
                    {(row.averageWinChance * 100).toFixed(0)}%
                  </span>
                  <span className="tabular w-20 shrink-0 text-right text-sm" style={{ color: 'var(--ink-faint)' }}>
                    {row.expectedWins.toFixed(1)} W
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
