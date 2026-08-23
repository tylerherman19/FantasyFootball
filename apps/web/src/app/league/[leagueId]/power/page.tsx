import { LeagueNav } from '@/components/LeagueNav';
import { RailBlock, RailLayout } from '@/components/design/DrillRail';
import { LeagueRail } from '@/components/design/LeagueRail';
import { Section, StatRow, StatTile } from '@/components/Section';
import {
  CellBar,
  HeatMap,
  Legend,
  LineChart,
  RangeBar,
  Scatter,
  Sparkline,
  StackedBar,
  formatPct,
  positionColor,
  rampColor,
  rampInk,
} from '@/components/charts/primitives';
import { buildTeamProfiles, contentionQuadrant, positionsInPlay } from '@/lib/league-analytics';
import { leagueMeta, lineupShape, loadLeague } from '@/lib/league-data';
import { requireSession } from '@/lib/session';

/**
 * The league, at a glance and in depth.
 *
 * This is the page that answers "where do I actually stand", and it answers it
 * six different ways because the honest answer depends on what you mean.
 * Projected points say one thing, market value another, simulated title odds a
 * third, and a roster that is strong and old is a different proposition from
 * one that is strong and young. Managers argue about all of it, so all of it is
 * here, on one scale each, next to each other.
 */

export default async function PowerPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  const { snapshot, result } = view;

  const profiles = await buildTeamProfiles(view);
  const positions = positionsInPlay(profiles);
  const corePositions = positions.filter((position) => ['QB', 'RB', 'WR', 'TE'].includes(position));

  const ranked = [...profiles].sort((a, b) => b.starterPoints - a.starterPoints);
  const maxStarterPoints = Math.max(...profiles.map((p) => p.starterPoints), 1);
  const maxTotalValue = Math.max(...profiles.map((p) => p.marketValue), 1);
  const maxRoster = Math.max(...profiles.map((p) => p.totalPoints), 1);

  const drafted = profiles.some((profile) => profile.rosterSize > 0);
  const hasMarket = profiles.some((profile) => profile.marketValue > 0);
  const hasHistory = profiles.some((profile) => profile.weeklyScores.length > 1);
  const hasAges = profiles.filter((profile) => profile.averageAge !== null).length >= 4;

  const mine = profiles.find((profile) => profile.isMine) ?? null;

  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };

  const medianAge = median(profiles.map((p) => p.averageAge).filter((age): age is number => age !== null));
  const medianStrength = median(profiles.map((p) => p.starterPoints));

  const standardError = (probability: number): number =>
    Math.sqrt(Math.max(probability * (1 - probability), 0) / Math.max(result.iterations, 1));

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="power"
        format={snapshot.league.format}
        stamps={[
          { label: 'Sims', value: result.iterations.toLocaleString() },
          { label: 'Model', value: view.modelVersion ?? 'none' },
          { label: 'Built in', value: `${view.loadMs} ms` },
        ]}
      />

      <RailLayout
        rail={
          <LeagueRail view={view}>
            <RailBlock title="What this page answers">
              Three rankings, deliberately. Market value, projected wins and title odds disagree, and the gaps are where the information is.
            </RailBlock>
          </LeagueRail>
        }
      >
        {!drafted ? (
          <div className="panel p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            <strong style={{ color: 'var(--ink)' }}>Nothing to rank yet.</strong> Every roster is
            empty, so there is no strength to measure. This page fills in the moment the draft
            happens.
          </div>
        ) : (
          <>
            {/* ---- league-wide context ------------------------------------ */}
            <Section
              title="The field"
              note="What a typical roster in this league looks like, so every number below has something to be compared against."
            >
              <StatRow columns={5}>
                <StatTile
                  label="Median starter pts"
                  value={medianStrength.toFixed(1)}
                  sub="per week, optimal lineup"
                />
                <StatTile
                  label="Strongest → weakest"
                  value={`${ranked[0]?.starterPoints.toFixed(0)} → ${ranked.at(-1)?.starterPoints.toFixed(0)}`}
                  sub={`${(((ranked[0]?.starterPoints ?? 0) / Math.max(ranked.at(-1)?.starterPoints ?? 1, 1) - 1) * 100).toFixed(0)}% spread`}
                />
                <StatTile
                  label="Median roster age"
                  value={hasAges ? `${medianAge.toFixed(1)}` : '—'}
                  sub={hasAges ? 'value-weighted years' : 'no birthdates'}
                />
                <StatTile
                  label="Playoff spots"
                  value={`${snapshot.league.playoffTeams} of ${snapshot.league.teamCount}`}
                  sub={`${formatPct(snapshot.league.playoffTeams / Math.max(snapshot.league.teamCount, 1))} of the field`}
                />
                <StatTile
                  label="Your rank"
                  value={
                    mine === null
                      ? '—'
                      : `#${ranked.findIndex((p) => p.isMine) + 1}`
                  }
                  sub={mine === null ? 'team not found' : `${mine.starterPoints.toFixed(1)} starter pts`}
                  emphasis
                />
              </StatRow>
            </Section>

            {/* ---- power rankings ----------------------------------------- */}
            <Section
              title="Power rankings"
              note={
                <>
                  Ranked by what the optimal lineup projects to score this week, broken down by where
                  those points come from. Two rosters with the same total are not the same team — the
                  bar shows whether a team is balanced or leaning on one position, which is what
                  decides how a single injury lands.
                </>
              }
              aside={<Legend items={corePositions.map((p) => ({ label: p, color: positionColor(p) }))} />}
            >
              <div className="panel scroll-x">
                <table className="data-table" style={{ minWidth: '58rem' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '2rem' }}>#</th>
                      <th style={{ minWidth: '9rem' }}>Team</th>
                      <th style={{ width: '17rem' }}>Starter points by position</th>
                      <th className="text-right">Start</th>
                      <th className="text-right">Bench</th>
                      {hasMarket && <th className="text-right">Value</th>}
                      <th className="text-right">Proj W</th>
                      <th style={{ width: '9rem' }}>Playoffs</th>
                      <th className="text-right">Title</th>
                      {hasHistory && <th className="text-right">Form</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((profile, index) => (
                      <tr key={profile.teamId} data-mine={profile.isMine}>
                        <td className="tabular" style={{ color: 'var(--ink-faint)' }}>
                          {index + 1}
                        </td>
                        <td className="max-w-[11rem] truncate" style={{ fontWeight: profile.isMine ? 700 : 400 }}>
                          {profile.name}
                        </td>
                        <td>
                          <StackedBar
                            max={maxStarterPoints}
                            width={260}
                            segments={corePositions.map((position) => {
                              const slice = profile.byPosition.find((s) => s.position === position);
                              return {
                                key: position,
                                value: slice?.starterPoints ?? 0,
                                color: positionColor(position),
                              };
                            })}
                          />
                        </td>
                        <td className="tabular text-right font-semibold">{profile.starterPoints.toFixed(1)}</td>
                        <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
                          {profile.benchPoints.toFixed(0)}
                        </td>
                        {hasMarket && (
                          <td className="tabular text-right">
                            <CellBar
                              value={profile.marketValue}
                              max={maxTotalValue}
                              width={48}
                              color="var(--pos-qb)"
                              label={profile.marketValue.toLocaleString()}
                            />
                          </td>
                        )}
                        <td className="tabular text-right">{profile.expectedWins.toFixed(1)}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <RangeBar
                              value={profile.playoffPct}
                              low={Math.max(0, profile.playoffPct - 1.96 * standardError(profile.playoffPct))}
                              high={Math.min(1, profile.playoffPct + 1.96 * standardError(profile.playoffPct))}
                              width={72}
                              color={profile.isMine ? 'var(--accent)' : 'var(--p-high)'}
                            />
                            <span className="tabular text-xs">{formatPct(profile.playoffPct)}</span>
                          </div>
                        </td>
                        <td className="tabular text-right font-semibold">{formatPct(profile.titlePct, 1)}</td>
                        {hasHistory && (
                          <td>
                            <div className="flex justify-end">
                              <Sparkline
                                values={profile.weeklyScores}
                                color={profile.isMine ? 'var(--accent)' : 'var(--p-high)'}
                              />
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* ---- positional heat map ------------------------------------ */}
            <Section
              title="Positional strength"
              note={
                <>
                  Each team&apos;s starting points at each position, coloured against the rest of the
                  league — the stronger the colour, the higher that team ranks at that position.
                  Read across for a team&apos;s shape, down for where the league is thin. A column
                  that is washed out everywhere is a position nobody has solved, which is where the
                  waiver wire and the trade market are worth the most.
                </>
              }
            >
              <div className="panel p-3">
                <HeatMap
                  columns={positions}
                  highlightRow={mine?.teamId}
                  rows={ranked.map((profile) => ({
                    key: profile.teamId,
                    label: profile.name,
                    cells: profile.byPosition.map((slice) => ({
                      intensity: slice.strength,
                      label: slice.starterPoints.toFixed(0),
                      title: `${profile.name} — ${slice.position}: ${slice.starterPoints.toFixed(1)} starter pts, #${slice.rank} in league, ${slice.count} rostered`,
                    })),
                  }))}
                />
              </div>
            </Section>

            {/* ---- finishing position grid -------------------------------- */}
            {result.teams.some((team) => team.rankDistribution.length > 1) && (
              <Section
                title="Where every team finishes"
                note={
                  <>
                    Out of {result.iterations.toLocaleString()} simulated seasons, how often each team
                    ends up in each final standing position. A row that is spread wide is a season
                    still genuinely undecided; a row concentrated in two or three cells is a team
                    whose range is already narrow.
                  </>
                }
                aside={
                  <span className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                    columns = final position
                  </span>
                }
              >
                <div className="panel scroll-x p-3">
                  <table style={{ minWidth: `${11 + profiles.length * 2.6}rem` }}>
                    <thead>
                      <tr>
                        <th style={{ width: '9rem' }} />
                        {profiles.map((_, index) => (
                          <th key={index} className="axis-label pb-1 text-center">
                            {index + 1}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...profiles]
                        .sort((a, b) => b.playoffPct - a.playoffPct || b.expectedWins - a.expectedWins)
                        .map((profile) => (
                          <tr key={profile.teamId}>
                            <td
                              className="truncate pr-2 text-xs"
                              style={{
                                maxWidth: '9rem',
                                fontWeight: profile.isMine ? 700 : 400,
                                color: profile.isMine ? 'var(--accent)' : 'var(--ink)',
                              }}
                            >
                              {profile.name}
                            </td>
                            {profile.rankDistribution.map((share, position) => (
                              <td key={position} className="p-px">
                                <div
                                  title={`${profile.name}: finishes ${position + 1}${position + 1 === 1 ? 'st' : ''} in ${formatPct(share, 1)} of seasons`}
                                  className="tabular flex h-6 items-center justify-center rounded-[2px] text-[10px]"
                                  style={{
                                    background: rampColor(Math.min(1, share * 3)),
                                    color: rampInk(Math.min(1, share * 3)),
                                    // The playoff cut is the only line on this
                                    // grid that changes what a cell means.
                                    borderRight:
                                      position + 1 === snapshot.league.playoffTeams
                                        ? '2px solid var(--ink)'
                                        : undefined,
                                  }}
                                >
                                  {share >= 0.005 ? (share * 100).toFixed(0) : ''}
                                </div>
                              </td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                    Cells are percentages. The heavy rule marks the playoff cut — everything left of
                    it makes the bracket.
                  </p>
                </div>
              </Section>
            )}

            {/* ---- roster construction ------------------------------------ */}
            <Section
              title="Roster construction"
              note={
                <>
                  Starters against bench, in projected points. Depth is real — it is what survives a
                  bye week and an injury — but it only scores when it gets promoted, so a team whose
                  bar is mostly pale is carrying value it cannot use.
                </>
              }
              aside={
                <Legend
                  items={[
                    { label: 'Starters', color: 'var(--p-high)' },
                    { label: 'Bench', color: 'var(--p-low)' },
                  ]}
                />
              }
            >
              <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
                {ranked.map((profile) => (
                  <div key={profile.teamId} className="flex items-center gap-3 px-3 py-2">
                    <span
                      className="w-32 shrink-0 truncate text-xs"
                      style={{ fontWeight: profile.isMine ? 700 : 400 }}
                    >
                      {profile.name}
                    </span>
                    <span className="min-w-0 flex-1">
                      <StackedBar
                        max={maxRoster}
                        width={420}
                        height={14}
                        showLabels={false}
                        segments={[
                          { key: 'Starters', value: profile.starterPoints, color: 'var(--p-high)' },
                          { key: 'Bench', value: profile.benchPoints, color: 'var(--p-low)' },
                        ]}
                      />
                    </span>
                    <span className="tabular w-12 shrink-0 text-right text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                      {profile.rosterSize}
                    </span>
                    <span
                      className="tabular w-14 shrink-0 text-right text-[11px]"
                      title="Share of starting points from this team's two best players"
                      style={{ color: profile.topTwoShare > 0.42 ? 'var(--warn)' : 'var(--ink-faint)' }}
                    >
                      {formatPct(profile.topTwoShare)}
                    </span>
                  </div>
                ))}
                <div className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-32 shrink-0" />
                  <span className="flex-1" />
                  <span className="axis-label w-12 shrink-0 text-right">size</span>
                  <span className="axis-label w-14 shrink-0 text-right">top 2</span>
                </div>
              </div>
            </Section>

            {/* ---- contention window -------------------------------------- */}
            {hasAges && (
              <Section
                title="Contention window"
                note={
                  <>
                    Roster age against current strength. Age is weighted by market value, so a
                    36-year-old kicker doesn&apos;t drag a young roster old. The quadrants are the
                    four real situations a team can be in — and the two on the right buy and sell
                    opposite things, which is where trades actually come from.
                  </>
                }
                aside={
                  mine === null ? undefined : (
                    <span className="text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
                      You: {contentionQuadrant(mine, medianAge, medianStrength)}
                    </span>
                  )
                }
              >
                <div className="panel p-3">
                  <Scatter
                    xLabel="Value-weighted roster age →"
                    yLabel="Starter points →"
                    xMedian={medianAge}
                    yMedian={medianStrength}
                    quadrantLabels={['Contending, young', 'Win now', 'Retool', 'Building']}
                    points={profiles
                      .filter((profile) => profile.averageAge !== null)
                      .map((profile) => ({
                        key: profile.teamId,
                        x: profile.averageAge ?? 0,
                        y: profile.starterPoints,
                        label: `${profile.name} — ${(profile.averageAge ?? 0).toFixed(1)} yrs, ${profile.starterPoints.toFixed(1)} pts, ${formatPct(profile.titlePct, 1)} title`,
                        color: profile.isMine ? 'var(--accent)' : 'var(--p-high)',
                        radius: 4 + Math.sqrt(Math.max(profile.titlePct, 0)) * 9,
                        emphasis: profile.isMine,
                      }))}
                  />
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                    Dot size is title probability.
                  </p>
                </div>
              </Section>
            )}

            {/* ---- scoring history ---------------------------------------- */}
            {hasHistory && (
              <Section
                title="Points scored, by week"
                note="Completed weeks only. Your line is drawn over the field — the comparison matters, but only as context for yours."
              >
                <div className="panel p-3">
                  <LineChart
                    yFormat={(value) => value.toFixed(0)}
                    xLabel="Week"
                    series={profiles
                      .filter((profile) => profile.weeklyScores.length > 1)
                      .map((profile) => ({
                        key: profile.teamId,
                        label: profile.name,
                        emphasis: profile.isMine,
                        color: profile.isMine ? 'var(--accent)' : undefined,
                        points: profile.weeklyScores.map((points, index) => ({ x: index + 1, y: points })),
                      }))}
                  />
                </div>
              </Section>
            )}

            {/* ---- manager efficiency ------------------------------------- */}
            {profiles.some((profile) => profile.lineupEfficiency > 0) && (
              <Section
                title="Manager lineup efficiency"
                note={
                  <>
                    Points actually scored as a share of what each manager&apos;s best available
                    lineup would have scored. Nobody hits 100% — the point is that the simulation
                    uses each manager&apos;s own measured rate rather than assuming everyone is
                    perfect, which would systematically overrate deep benches that never get started.
                  </>
                }
              >
                <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
                  {[...profiles]
                    .filter((profile) => profile.lineupEfficiency > 0)
                    .sort((a, b) => b.lineupEfficiency - a.lineupEfficiency)
                    .map((profile) => (
                      <div key={profile.teamId} className="flex items-center gap-3 px-3 py-1.5">
                        <span
                          className="w-32 shrink-0 truncate text-xs"
                          style={{ fontWeight: profile.isMine ? 700 : 400 }}
                        >
                          {profile.name}
                        </span>
                        <CellBar
                          value={profile.lineupEfficiency}
                          max={1}
                          width={200}
                          color={profile.isMine ? 'var(--accent)' : 'var(--p-mid)'}
                        />
                        <span className="tabular text-xs">{formatPct(profile.lineupEfficiency, 1)}</span>
                      </div>
                    ))}
                </div>
              </Section>
            )}
          </>
        )}
      </RailLayout>
    </>
  );
}
