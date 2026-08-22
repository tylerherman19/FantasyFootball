import { LeagueNav } from '@/components/LeagueNav';
import { Section, StatRow, StatTile } from '@/components/Section';
import {
  CellBar,
  DivergingBar,
  Histogram,
  Legend,
  RangeBar,
  Sparkline,
  StackedBar,
  formatPct,
  positionColor,
  rampColor,
  rampInk,
} from '@/components/charts/primitives';
import { remainingSchedule, weekLeverage } from '@/lib/analysis';
import { buildTeamProfiles } from '@/lib/league-analytics';
import { PositionalHeatmap } from '@/components/PositionalHeatmap';
import { Takeaway } from '@/components/Takeaway';
import { leagueMeta, lineupShape, loadLeague } from '@/lib/league-data';
import { positionalStrength } from '@/lib/positional-strength';
import { requireSession } from '@/lib/session';
import { InsightList } from '@/components/design/primitives';
import { Figure } from '@/components/design/Figure';
import { OddsField } from '@/components/charts/OddsField';
import { buildInsights } from '@/lib/insights';
import { analysePortfolio, loadCorrelations, type PortfolioPlayer } from '@/lib/portfolio';
import { loadAvailability } from '@/lib/availability';
import { loadArtifact, loadLatestArtifact, scoreFor } from '@/lib/projections';
import { loadMarketValues } from '@/lib/values';
import { readFreshness } from '@/lib/refresh-runner';
import { analyzeRoster } from '@/lib/roster-analysis';

/**
 * Where the season stands, and what moves it.
 *
 * Four questions in order of what a manager actually wants: how am I doing,
 * how uncertain is that, who is in my way, and what should I want to happen
 * this week. Each gets a picture first and a number second.
 */

export default async function OutlookPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  const { snapshot, result, teamNames, myTeamId } = view;
  const isGuillotine = snapshot.league.format === 'guillotine';

  const rosteredPlayers = snapshot.rosters.reduce((sum, r) => sum + r.playerIds.length, 0);
  const notDrafted = rosteredPlayers === 0;

  const standings = [...result.teams].sort((a, b) =>
    isGuillotine
      ? b.titlePct - a.titlePct
      : b.playoffPct - a.playoffPct || b.expectedWins - a.expectedWins,
  );

  const me = myTeamId === null ? null : (result.teams.find((t) => t.teamId === myTeamId) ?? null);
  const myRank = me === null ? null : standings.findIndex((t) => t.teamId === me.teamId) + 1;
  const myRecord = myTeamId === null ? null : (snapshot.records.find((r) => r.teamId === myTeamId) ?? null);

  const schedule = !notDrafted && myTeamId !== null && !isGuillotine ? remainingSchedule(view, myTeamId) : [];
  const leverage =
    !notDrafted && myTeamId !== null && !isGuillotine ? weekLeverage(view, myTeamId, snapshot.asOfWeek) : [];

  const profiles = notDrafted ? [] : await buildTeamProfiles(view);
  const strengths = notDrafted ? [] : positionalStrength(view);
  const profileOf = new Map(profiles.map((profile) => [profile.teamId, profile]));
  const maxStarterPoints = Math.max(...profiles.map((p) => p.starterPoints), 1);
  const corePositions = ['QB', 'RB', 'WR', 'TE'];

  const standardError = (probability: number): number =>
    Math.sqrt(Math.max(probability * (1 - probability), 0) / Math.max(result.iterations, 1));

  /*
   * "What matters right now" (§44).
   *
   * Assembled from outputs the model already produced rather than computed
   * afresh, so an insight cannot disagree with the page it sits above. Every
   * lookup is defensive: a missing artifact should cost one insight, never the
   * whole page.
   */
  const [homeArtifact, homeValues, homeAvailability, homeFreshness, rosterAnalysis, homeCorrelations] =
    await Promise.all([
      loadArtifact(snapshot.league.season, snapshot.asOfWeek).catch(() => null),
      loadMarketValues(snapshot.league.format, snapshot.league.superFlex).catch(() => new Map()),
      loadAvailability().catch(() => ({}) as Record<string, { injuryStatus: string | null }>),
      readFreshness(null).catch(() => []),
      myTeamId === null || notDrafted
        ? Promise.resolve(null)
        : analyzeRoster(view, myTeamId).catch(() => null),
      loadCorrelations().catch(() => null),
    ]);

  const myRosterPlayers =
    myTeamId === null
      ? []
      : (snapshot.rosters.find((r) => r.teamId === myTeamId)?.playerIds ?? []).map(String);

  const homePortfolio =
    homeArtifact === null || myRosterPlayers.length === 0
      ? null
      : analysePortfolio(
          myRosterPlayers.flatMap((id): PortfolioPlayer[] => {
            const entry = homeArtifact.players[id];
            if (entry === undefined) return [];
            return [
              {
                playerId: id,
                name: entry.name,
                position: entry.position,
                team: entry.team,
                mean: scoreFor(entry, snapshot.league.scoring.raw, null, snapshot.asOfWeek),
                sd: entry.sd,
                gameId: entry.gameId,
                gameLoading: entry.gameLoading,
                marketValue: homeValues.get(id)?.value ?? 0,
              },
            ];
          }),
          homeCorrelations,
        );

  const insights = buildInsights({
    leagueId,
    titleOdds: me?.titlePct ?? null,
    playoffOdds: me?.playoffPct ?? null,
    rosterCount: myRosterPlayers.length,
    // A starter the solver would bench in favour of somebody on the bench.
    benchedBetter: (rosterAnalysis?.players ?? [])
      .filter((p) => !p.starting && p.marginal > 0.5)
      .slice(0, 2)
      .map((bench) => ({
        startName:
          (rosterAnalysis?.players ?? [])
            .filter((p) => p.starting && p.position === bench.position)
            .sort((a, b) => a.projected - b.projected)[0]?.name ?? 'a starter',
        benchName: bench.name,
        gain: bench.marginal,
      })),
    rookiesUnvalued: myRosterPlayers
      .map((id) => homeArtifact?.players[id])
      .filter((p) => p !== undefined && p.basis === 'rookie-prior')
      .map((p) => p!.name),
    portfolio: homePortfolio,
    freshness: homeFreshness,
    modelAgeMinutes:
      homeArtifact === null
        ? null
        : Math.round((Date.now() - Date.parse(homeArtifact.generatedAt)) / 60_000),
    injuredStarters: (rosterAnalysis?.players ?? [])
      .filter((p) => p.starting && p.injuryStatus !== null && p.injuryStatus !== '')
      .map((p) => ({ name: p.name, status: p.injuryStatus as string })),
  });

  const myProfile = profiles.find((profile) => profile.isMine) ?? null;
  const leagueAverageStarters =
    profiles.length > 0 ? profiles.reduce((sum, p) => sum + p.starterPoints, 0) / profiles.length : 0;

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="outlook"
        format={snapshot.league.format}
        stamps={[
          { label: 'Sims', value: result.iterations.toLocaleString() },
          { label: 'Model', value: view.modelVersion ?? 'none' },
          { label: 'Built in', value: `${view.loadMs} ms` },
        ]}
      />

      <main className="mx-auto max-w-6xl px-5 pb-20 lg:pl-[4.75rem]">
        {/*
         * Lead with a picture (§42).
         *
         * The page opened with a ranked list of text, and a ranked list cannot
         * show the thing that decides a dynasty season: whether the league is
         * bunched — one trade moves you three places — or already split, in
         * which case it does not.
         */}
        {!notDrafted && result.teams.length > 1 && (
          <Figure
            headline={
              me === null
                ? `${snapshot.league.name} is ${
                    Math.max(...result.teams.map((t) => t.titlePct)) -
                      Math.min(...result.teams.map((t) => t.titlePct)) >
                    0.25
                      ? 'already split'
                      : 'still bunched'
                  }`
                : `You are ${myRank === null ? '—' : `${myRank} of ${standings.length}`} to win ${snapshot.league.name}`
            }
            deck={
              me === null
                ? 'Championship probability across every team, from the same simulation the rest of this page uses.'
                : `${(me.titlePct * 100).toFixed(1)}% to win it and ${(me.playoffPct * 100).toFixed(0)}% to reach the playoffs, over ${result.iterations.toLocaleString()} simulated seasons. Hover any dot for that team.`
            }
            source={`${result.iterations.toLocaleString()} season simulations · model ${view.modelVersion ?? 'unknown'}`}
          >
            <OddsField
              teams={result.teams.map((team) => ({
                teamId: team.teamId,
                name: teamNames.get(team.teamId) ?? team.teamId,
                titlePct: team.titlePct,
                playoffPct: team.playoffPct,
                isMine: team.teamId === myTeamId,
              }))}
            />
          </Figure>
        )}

        {insights.length > 0 && (
          <Section
            title="What matters right now"
            note="Ranked by consequence. Every line is a threshold applied to a number the model already computed, and the number is quoted so you can disagree with the threshold rather than trust the sentence."
          >
            <InsightList insights={insights} />
          </Section>
        )}

        {/*
         * The conclusion before the evidence.
         *
         * Everything below this is a chart or a table, and none of them say
         * what to do about it. Leading with the finding — where the season
         * stands, which position is actually short, what move follows — is the
         * difference between a page that reports and a page that advises.
         */}
        <Takeaway
          input={{
            teamName: myTeamId === null ? 'This team' : (teamNames.get(myTeamId) ?? 'This team'),
            rank: me === null ? 0 : result.teams.filter((t) => t.titlePct > me.titlePct).length + 1,
            teamCount: snapshot.league.teamCount,
            playoffPct: me?.playoffPct ?? 0,
            titlePct: me?.titlePct ?? 0,
            expectedWins: me?.expectedWins ?? 0,
            regularSeasonWeeks: snapshot.league.regularSeasonWeeks,
            strength:
              myTeamId === null
                ? null
                : (strengths.find((team) => team.teamId === myTeamId) ?? null),
            undrafted: notDrafted,
          }}
        />
        {notDrafted && (
          <div className="panel mb-7 p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            <strong style={{ color: 'var(--ink)' }}>Not drafted yet.</strong> Every roster is empty,
            so there is nothing to simulate. This page becomes meaningful the moment the draft
            happens.
          </div>
        )}

        {myTeamId === null && !notDrafted && (
          <div className="panel mb-7 p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            <strong style={{ color: 'var(--ink)' }}>
              Couldn&apos;t find {session.username} in this league.
            </strong>{' '}
            League-wide numbers below are still correct; anything personal — start/sit, waivers,
            leverage — needs to know which team is yours.
          </div>
        )}

        {/* ---- your season -------------------------------------------- */}
        {me !== null && !notDrafted && (
          <Section title="Your season">
            <StatRow columns={5}>
              <StatTile label="Projected rank" value={`#${myRank} of ${standings.length}`} />
              <StatTile
                label="Projected record"
                value={`${me.expectedWins.toFixed(1)}-${(snapshot.league.regularSeasonWeeks - me.expectedWins).toFixed(1)}`}
                sub={myRecord === null ? undefined : `now ${myRecord.wins}-${myRecord.losses}`}
              />
              <StatTile
                label={isGuillotine ? 'Survive to end' : 'Playoffs'}
                value={formatPct(isGuillotine ? me.titlePct : me.playoffPct)}
                sub={`±${(1.96 * standardError(isGuillotine ? me.titlePct : me.playoffPct) * 100).toFixed(1)} pts`}
                emphasis
              />
              <StatTile label="Title" value={formatPct(me.titlePct, 1)} emphasis />
              <StatTile
                label="Lineup vs field"
                value={
                  myProfile === null
                    ? '—'
                    : `${myProfile.starterPoints > leagueAverageStarters ? '+' : ''}${(myProfile.starterPoints - leagueAverageStarters).toFixed(1)}`
                }
                sub="points per week vs average"
                tone={
                  myProfile === null
                    ? undefined
                    : myProfile.starterPoints >= leagueAverageStarters
                      ? 'good'
                      : 'bad'
                }
              />
            </StatRow>
          </Section>
        )}

        {/* ---- outcome distribution ------------------------------------ */}
        {me !== null && !notDrafted && !isGuillotine && me.winDistribution.length > 1 && (
          <Section
            title="Where your season can land"
            note={
              <>
                Every simulated season, by final win total. The dashed line is your average; the
                highlighted bars are the outcomes that make the playoffs. The width of this
                distribution is the honest answer to how much of your season is already decided.
              </>
            }
          >
            <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
              <div className="panel p-3">
                <Histogram
                  bins={me.winDistribution}
                  labels={me.winDistribution.map((_, wins) => String(wins))}
                  mean={me.expectedWins}
                  highlightFrom={playoffWinThreshold(me.winDistribution, me.playoffPct)}
                  height={110}
                />
                <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                  Final wins, out of {snapshot.league.regularSeasonWeeks}
                  {snapshot.league.medianWins ? ' weeks × 2 (median wins)' : ' weeks'}.
                </p>
              </div>

              {me.rankDistribution.length > 1 && (
                <div className="panel p-3">
                  <div className="eyebrow mb-2">Finishing position</div>
                  <div className="flex flex-wrap gap-1">
                    {me.rankDistribution.map((share, index) => (
                      <div
                        key={index}
                        title={`Finishes #${index + 1} in ${formatPct(share, 1)} of seasons`}
                        className="tabular flex h-9 flex-1 min-w-[2rem] flex-col items-center justify-center rounded-[3px] text-[10px]"
                        style={{
                          background: rampColor(Math.min(1, share * 3)),
                          color: rampInk(Math.min(1, share * 3)),
                          outline:
                            index + 1 === snapshot.league.playoffTeams ? '2px solid var(--ink)' : undefined,
                          outlineOffset: '-2px',
                        }}
                      >
                        <span className="font-semibold">{index + 1}</span>
                        <span>{share >= 0.005 ? (share * 100).toFixed(0) : '·'}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                    Percent of seasons ending in each position. The outlined cell is the last playoff
                    spot.
                  </p>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ---- league table -------------------------------------------- */}
        {!notDrafted && (
          <Section
            title="League outlook"
            note="Every team, with the roster behind the odds. The bar is projected starting points by position — the same total split by where it comes from."
            aside={<Legend items={corePositions.map((p) => ({ label: p, color: positionColor(p) }))} />}
          >
            <div className="panel scroll-x">
              <table className="data-table" style={{ minWidth: '54rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '2rem' }}>#</th>
                    <th style={{ minWidth: '9rem' }}>Team</th>
                    <th style={{ width: '15rem' }}>Roster shape</th>
                    <th className="text-right">Proj W</th>
                    <th className="text-right">Rec</th>
                    <th style={{ width: '9rem' }}>{isGuillotine ? 'Survives' : 'Playoffs'}</th>
                    <th className="text-right">Title</th>
                    <th className="text-right">Form</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((team, index) => {
                    const profile = profileOf.get(team.teamId);
                    const record = snapshot.records.find((r) => r.teamId === team.teamId);
                    const probability = isGuillotine ? team.titlePct : team.playoffPct;

                    return (
                      <tr key={team.teamId} data-mine={team.teamId === myTeamId}>
                        <td className="tabular" style={{ color: 'var(--ink-faint)' }}>
                          {index + 1}
                        </td>
                        <td
                          className="max-w-[11rem] truncate"
                          style={{ fontWeight: team.teamId === myTeamId ? 700 : 400 }}
                        >
                          {teamNames.get(team.teamId) ?? team.teamId}
                        </td>
                        <td>
                          {profile === undefined ? null : (
                            <StackedBar
                              max={maxStarterPoints}
                              width={230}
                              height={14}
                              showLabels={false}
                              segments={corePositions.map((position) => ({
                                key: position,
                                value:
                                  profile.byPosition.find((slice) => slice.position === position)
                                    ?.starterPoints ?? 0,
                                color: positionColor(position),
                              }))}
                            />
                          )}
                        </td>
                        <td className="tabular text-right font-semibold">{team.expectedWins.toFixed(1)}</td>
                        <td className="tabular text-right text-xs" style={{ color: 'var(--ink-faint)' }}>
                          {record === undefined ? '—' : `${record.wins}-${record.losses}`}
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <RangeBar
                              value={probability}
                              low={Math.max(0, probability - 1.96 * standardError(probability))}
                              high={Math.min(1, probability + 1.96 * standardError(probability))}
                              width={80}
                              color={team.teamId === myTeamId ? 'var(--accent)' : 'var(--p-high)'}
                            />
                            <span className="tabular text-xs">{formatPct(probability)}</span>
                          </div>
                        </td>
                        <td className="tabular text-right font-semibold">{formatPct(team.titlePct, 1)}</td>
                        <td>
                          <div className="flex justify-end">
                            {profile !== undefined && profile.weeklyScores.length > 1 ? (
                              <Sparkline
                                values={profile.weeklyScores}
                                color={team.teamId === myTeamId ? 'var(--accent)' : 'var(--p-high)'}
                              />
                            ) : (
                              <span className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                                —
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* ---- remaining schedule -------------------------------------- */}
        {schedule.length > 0 && (
          <Section
            title="Your remaining schedule"
            note="Win probability from projected totals and their spread, not from record. The bar under each week is your projected margin."
          >
            <div className="scroll-x">
              <div className="flex gap-1.5 pb-1">
                {schedule.map((game) => {
                  const margin = game.projectedFor - game.projectedAgainst;
                  return (
                    <div
                      key={game.matchupId}
                      className="panel min-w-[7.5rem] shrink-0 p-2.5"
                      style={{
                        borderColor:
                          game.winProbability >= 0.6
                            ? 'color-mix(in srgb, var(--good) 35%, var(--rule))'
                            : game.winProbability <= 0.4
                              ? 'color-mix(in srgb, var(--bad) 35%, var(--rule))'
                              : 'var(--rule)',
                      }}
                    >
                      <div className="axis-label">Week {game.week}</div>
                      <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {game.opponentName}
                      </div>
                      <div
                        className="tabular mt-1.5 text-lg font-semibold"
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
                      </div>
                      <div className="mt-1">
                        <DivergingBar value={margin} max={30} width={92} height={8} />
                      </div>
                      <div className="tabular mt-1 text-[10px]" style={{ color: 'var(--ink-faint)' }}>
                        {game.projectedFor.toFixed(0)} – {game.projectedAgainst.toFixed(0)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Section>
        )}

        {/* ---- leverage ------------------------------------------------- */}
        {leverage.length > 0 && (
          <Section
            title={`What to root for, week ${snapshot.asOfWeek}`}
            note={
              <>
                Every game this week replayed both ways against the same simulated seasons. The bar
                spans your playoff odds if it goes the wrong way to your odds if it goes your way —
                the width is what the result is worth to you.
              </>
            }
          >
            <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
              {leverage.map((item) => {
                const low = Math.min(item.playoffIfLose, item.playoffIfWin);
                const high = Math.max(item.playoffIfLose, item.playoffIfWin);

                return (
                  <div key={item.matchupId} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs" style={{ fontWeight: item.isMine ? 700 : 400 }}>
                      {item.description}
                    </span>
                    <span className="hidden sm:block">
                      <RangeBar
                        value={high}
                        low={low}
                        high={high}
                        width={150}
                        color={item.isMine ? 'var(--accent)' : 'var(--p-high)'}
                      />
                    </span>
                    <span className="tabular w-24 shrink-0 text-right text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                      {formatPct(low)} → {formatPct(high)}
                    </span>
                    <span
                      className="tabular w-14 shrink-0 text-right text-xs font-semibold"
                      style={{ color: 'var(--accent)' }}
                    >
                      ±{(item.swing * 100).toFixed(1)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* ---- guillotine survival ------------------------------------- */}
        {isGuillotine && !notDrafted && (
          <Section
            title="Survival curve"
            note="Chance of still being alive at the end of each week. In a guillotine league this replaces the playoff race entirely — there is no bracket, only elimination."
          >
            <div className="panel scroll-x p-3">
              <table className="data-table" style={{ minWidth: '40rem' }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: '9rem' }}>Team</th>
                    {(standings[0]?.survivalByWeek ?? []).map((_, week) =>
                      week === 0 ? null : (
                        <th key={week} className="text-center">
                          {week}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {standings.map((team) => (
                    <tr key={team.teamId} data-mine={team.teamId === myTeamId}>
                      <td className="max-w-[11rem] truncate">{teamNames.get(team.teamId) ?? team.teamId}</td>
                      {team.survivalByWeek.map((share, week) =>
                        week === 0 ? null : (
                          <td key={week} className="p-px">
                            <div
                              title={`Week ${week}: ${formatPct(share, 1)} alive`}
                              className="tabular flex h-6 items-center justify-center rounded-[2px] text-[10px]"
                              style={{ background: rampColor(share), color: rampInk(share) }}
                            >
                              {(share * 100).toFixed(0)}
                            </div>
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* ---- positional edge ----------------------------------------- */}
        {myProfile !== null && profiles.length > 1 && (
          <Section
            title="Where you win and lose"
            note="Your projected starting points at each position against the league average. This is the shortlist for what to trade for and what to trade away."
          >
            <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
              {myProfile.byPosition
                .filter((slice) => slice.count > 0)
                .map((slice) => {
                  const average =
                    profiles.reduce(
                      (sum, profile) =>
                        sum + (profile.byPosition.find((s) => s.position === slice.position)?.starterPoints ?? 0),
                      0,
                    ) / profiles.length;
                  const gap = slice.starterPoints - average;

                  return (
                    <div key={slice.position} className="flex items-center gap-3 px-3 py-2">
                      <span className="w-10 shrink-0">
                        <span className="pos-chip" style={{ background: positionColor(slice.position) }}>
                          {slice.position}
                        </span>
                      </span>
                      <span className="tabular w-16 shrink-0 text-xs" style={{ color: 'var(--ink-faint)' }}>
                        #{slice.rank} of {profiles.length}
                      </span>
                      <span className="flex-1">
                        <DivergingBar
                          value={gap}
                          max={Math.max(
                            ...profiles.map((profile) =>
                              Math.abs(
                                (profile.byPosition.find((s) => s.position === slice.position)?.starterPoints ?? 0) -
                                  average,
                              ),
                            ),
                            1,
                          )}
                          width={200}
                          label={`${gap >= 0 ? '+' : ''}${gap.toFixed(1)}`}
                        />
                      </span>
                      <span className="tabular w-16 shrink-0 text-right text-xs">
                        {slice.starterPoints.toFixed(1)}
                      </span>
                      <span className="hidden w-24 shrink-0 sm:block">
                        <CellBar
                          value={slice.strength}
                          max={1}
                          width={80}
                          color={positionColor(slice.position)}
                        />
                      </span>
                    </div>
                  );
                })}
            </div>
          </Section>
        )}
        <PositionalHeatmap
          strengths={strengths}
          teamNames={view.teamNames}
          myTeamId={view.myTeamId}
        />
      </main>
    </>
  );
}

/**
 * The lowest win total that still makes the playoffs, read back out of the
 * simulation rather than assumed.
 *
 * There is no fixed number of wins that qualifies — it depends on the league —
 * so the threshold is found by walking down from the top until the cumulative
 * share of seasons matches the playoff probability the simulation reported.
 */
const playoffWinThreshold = (winDistribution: readonly number[], playoffPct: number): number => {
  let cumulative = 0;
  for (let wins = winDistribution.length - 1; wins >= 0; wins -= 1) {
    cumulative += winDistribution[wins] ?? 0;
    if (cumulative >= playoffPct) return wins;
  }
  return 0;
};
