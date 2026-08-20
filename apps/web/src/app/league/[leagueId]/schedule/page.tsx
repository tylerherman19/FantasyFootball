import { LeagueNav } from '@/components/LeagueNav';
import { Section, StatRow, StatTile } from '@/components/Section';
import {
  CellBar,
  DivergingBar,
  formatPct,
  rampColor,
  rampInk,
} from '@/components/charts/primitives';
import { remainingSchedule, teamWeekStrength, winProbability } from '@/lib/analysis';
import { leagueMeta, lineupShape, loadLeague } from '@/lib/league-data';
import { requireSession } from '@/lib/session';

/**
 * Who you still have to play, and what it costs you.
 *
 * Two managers with identical rosters can have very different seasons ahead,
 * and nothing in the standings says so. The grid is the answer: every team's
 * remaining games as a strip of win probabilities, so a brutal run and a clear
 * run are visible as shapes before a single number is read.
 */

export default async function SchedulePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  const { snapshot, myTeamId, teamNames } = view;

  const isGuillotine = snapshot.league.format === 'guillotine';
  const mySchedule = myTeamId === null || isGuillotine ? [] : remainingSchedule(view, myTeamId);

  /**
   * Every team's remaining games, priced.
   *
   * Each team is measured against a common yardstick — its own projected weekly
   * strength — so the numbers compare. Computed once here and reused by both
   * the grid and the summary, because `teamWeekStrength` solves an optimal
   * lineup per call and this would otherwise do it a few hundred times.
   */
  const strengthCache = new Map<string, { mean: number; sd: number }>();
  const strengthOf = (teamId: string, week: number) => {
    const key = `${teamId}:${week}`;
    const hit = strengthCache.get(key);
    if (hit !== undefined) return hit;
    const value = teamWeekStrength(view, teamId, week);
    strengthCache.set(key, value);
    return value;
  };

  const weeks: number[] = [];
  for (let week = snapshot.asOfWeek; week <= snapshot.league.regularSeasonWeeks; week += 1) {
    weeks.push(week);
  }

  const rows = snapshot.rosters
    .map((roster) => {
      const games = snapshot.schedule.filter(
        (matchup) => matchup.week >= snapshot.asOfWeek && matchup.teamIds.includes(roster.teamId),
      );
      if (games.length === 0) return null;

      const mine = strengthOf(roster.teamId, snapshot.asOfWeek);

      const byWeek = new Map<number, { opponent: string; win: number }>();
      for (const game of games) {
        const opponentId = game.teamIds[0] === roster.teamId ? game.teamIds[1] : game.teamIds[0];
        byWeek.set(game.week, {
          opponent: teamNames.get(opponentId) ?? opponentId,
          win: winProbability(mine, strengthOf(opponentId, game.week)),
        });
      }

      const chances = [...byWeek.values()].map((entry) => entry.win);

      return {
        teamId: roster.teamId,
        name: teamNames.get(roster.teamId) ?? roster.teamId,
        isMine: roster.teamId === myTeamId,
        byWeek,
        games: games.length,
        expectedWins: chances.reduce((sum, value) => sum + value, 0),
        averageWinChance: chances.reduce((sum, value) => sum + value, 0) / Math.max(chances.length, 1),
        hardest: Math.min(...chances),
        easiest: Math.max(...chances),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.averageWinChance - a.averageWinChance);

  const leagueAverage =
    rows.length > 0 ? rows.reduce((sum, row) => sum + row.averageWinChance, 0) / rows.length : 0.5;

  const mine = rows.find((row) => row.isMine) ?? null;

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="schedule"
        format={snapshot.league.format}
        stamps={[
          { label: 'Weeks left', value: String(weeks.length) },
          { label: 'From week', value: String(snapshot.asOfWeek) },
        ]}
      />

      <main className="mx-auto max-w-6xl px-5 pb-20 lg:pl-[4.75rem]">
        {isGuillotine && (
          <div className="panel mb-7 p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            <strong style={{ color: 'var(--ink)' }}>No schedule in a guillotine league.</strong>{' '}
            Nobody plays anybody — every team scores against the field and the lowest is eliminated.
            Survival odds live on the Outlook tab.
          </div>
        )}

        {mine !== null && (
          <Section title="Your road" >
            <StatRow columns={4}>
              <StatTile
                label="Games left"
                value={String(mine.games)}
                sub={`weeks ${snapshot.asOfWeek}–${snapshot.league.regularSeasonWeeks}`}
              />
              <StatTile
                label="Expected wins"
                value={mine.expectedWins.toFixed(1)}
                sub="from these games"
                emphasis
              />
              <StatTile
                label="Average game"
                value={formatPct(mine.averageWinChance)}
                sub={`league average ${formatPct(leagueAverage)}`}
                tone={mine.averageWinChance >= leagueAverage ? 'good' : 'bad'}
              />
              <StatTile
                label="Schedule rank"
                value={`#${rows.findIndex((row) => row.isMine) + 1} easiest`}
                sub={`of ${rows.length}`}
              />
            </StatRow>
          </Section>
        )}

        {rows.length > 0 && (
          <Section
            title="Every remaining game, priced"
            note={
              <>
                Each cell is one team&apos;s chance of winning that week, from projected totals and
                their spread rather than from record. Stronger colour is a likelier win — the scale
                sits to the right. Read across a row for a team&apos;s road; read down a column for
                the week the league as a whole finds hard.
              </>
            }
            aside={
              <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                <span>unlikely</span>
                {[0.1, 0.3, 0.5, 0.7, 0.9].map((value) => (
                  <span key={value} className="h-3 w-4 rounded-[2px]" style={{ background: rampColor(value) }} />
                ))}
                <span>likely</span>
              </span>
            }
          >
            <div className="panel scroll-x p-3">
              <table style={{ minWidth: `${13 + weeks.length * 2.9}rem` }}>
                <thead>
                  <tr>
                    <th style={{ width: '10rem' }} />
                    {weeks.map((week) => (
                      <th key={week} className="axis-label pb-1 text-center">
                        {week}
                      </th>
                    ))}
                    <th className="axis-label pb-1 pl-3 text-right">xW</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.teamId}>
                      <td
                        className="truncate pr-2 text-xs"
                        style={{
                          maxWidth: '10rem',
                          fontWeight: row.isMine ? 700 : 400,
                          color: row.isMine ? 'var(--accent)' : 'var(--ink)',
                        }}
                      >
                        {row.name}
                      </td>
                      {weeks.map((week) => {
                        const game = row.byWeek.get(week);
                        return (
                          <td key={week} className="p-px">
                            {game === undefined ? (
                              <div
                                className="flex h-6 items-center justify-center rounded-[2px] text-[10px]"
                                style={{ background: 'var(--surface-sunk)', color: 'var(--ink-faint)' }}
                              >
                                bye
                              </div>
                            ) : (
                              <div
                                title={`Week ${week} vs ${game.opponent}: ${formatPct(game.win)} to win`}
                                className="tabular flex h-6 items-center justify-center rounded-[2px] text-[10px] font-medium"
                                style={{ background: rampColor(game.win), color: rampInk(game.win) }}
                              >
                                {(game.win * 100).toFixed(0)}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="tabular pl-3 text-right text-xs font-semibold">
                        {row.expectedWins.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {rows.length > 0 && (
          <Section
            title="Strength of remaining schedule"
            note="Each team's average chance of winning its remaining games, against the league average. Identical rosters can face very different seasons, and this is where that shows up."
          >
            <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
              {rows.map((row) => (
                <div key={row.teamId} className="flex items-center gap-3 px-3 py-2">
                  <span
                    className="w-32 shrink-0 truncate text-xs"
                    style={{ fontWeight: row.isMine ? 700 : 400 }}
                  >
                    {row.name}
                  </span>
                  <CellBar
                    value={row.averageWinChance}
                    max={1}
                    width={130}
                    color={row.isMine ? 'var(--accent)' : 'var(--p-mid)'}
                    label={formatPct(row.averageWinChance)}
                  />
                  <span className="hidden flex-1 sm:block">
                    <DivergingBar
                      value={row.averageWinChance - leagueAverage}
                      max={Math.max(
                        ...rows.map((other) => Math.abs(other.averageWinChance - leagueAverage)),
                        0.01,
                      )}
                      width={140}
                      label={`${row.averageWinChance >= leagueAverage ? '+' : ''}${((row.averageWinChance - leagueAverage) * 100).toFixed(1)}`}
                    />
                  </span>
                  <span className="tabular w-24 shrink-0 text-right text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                    {formatPct(row.hardest)} – {formatPct(row.easiest)}
                  </span>
                  <span className="tabular w-12 shrink-0 text-right text-xs font-semibold">
                    {row.expectedWins.toFixed(1)}
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-3 px-3 py-1.5">
                <span className="w-32 shrink-0" />
                <span className="axis-label w-[130px]">avg win chance</span>
                <span className="hidden flex-1 sm:block" />
                <span className="axis-label w-24 shrink-0 text-right">hardest – easiest</span>
                <span className="axis-label w-12 shrink-0 text-right">xW</span>
              </div>
            </div>
          </Section>
        )}

        {mySchedule.length > 0 && (
          <Section
            title="Your remaining games, in detail"
            note="Projected totals for both sides, the margin between them, and what that implies."
          >
            <div className="panel scroll-x">
              <table className="data-table" style={{ minWidth: '34rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '3rem' }}>Wk</th>
                    <th style={{ minWidth: '10rem' }}>Opponent</th>
                    <th className="text-right">You</th>
                    <th className="text-right">Them</th>
                    <th style={{ width: '9rem' }}>Margin</th>
                    <th className="text-right">Win</th>
                  </tr>
                </thead>
                <tbody>
                  {mySchedule.map((game) => (
                    <tr key={game.matchupId}>
                      <td className="tabular" style={{ color: 'var(--ink-faint)' }}>
                        {game.week}
                      </td>
                      <td className="max-w-[13rem] truncate">{game.opponentName}</td>
                      <td className="tabular text-right">{game.projectedFor.toFixed(1)}</td>
                      <td className="tabular text-right" style={{ color: 'var(--ink-muted)' }}>
                        {game.projectedAgainst.toFixed(1)}
                      </td>
                      <td>
                        <DivergingBar
                          value={game.projectedFor - game.projectedAgainst}
                          max={30}
                          width={110}
                          label={`${game.projectedFor - game.projectedAgainst >= 0 ? '+' : ''}${(game.projectedFor - game.projectedAgainst).toFixed(1)}`}
                        />
                      </td>
                      <td
                        className="tabular text-right font-semibold"
                        style={{
                          color:
                            game.winProbability >= 0.6
                              ? 'var(--good)'
                              : game.winProbability <= 0.4
                                ? 'var(--bad)'
                                : 'var(--ink)',
                        }}
                      >
                        {formatPct(game.winProbability)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </main>
    </>
  );
}
