import Link from 'next/link';
import { Fragility } from '@/components/Fragility';
import { RailBlock, RailLayout, RailStat } from '@/components/design/DrillRail';
import { serializeLeague } from '@/lib/serialize';
import { loadEdgePlayerValues } from '@/lib/edge-values';
import { loadPlayerInfo } from '@/lib/players';
import { LeagueNav } from '@/components/LeagueNav';
import { SchemeLine } from '@/components/SchemeLine';
import { loadDefenses, opponentFrom } from '@/lib/defense';
import { loadSchemeFinding } from '@/lib/scheme-impact';
import { Section, StatRow, StatTile } from '@/components/Section';
import {
  CellBar,
  Legend,
  PositionChip,
  Scatter,
  StackedBar,
  formatPct,
  positionColor,
} from '@/components/charts/primitives';
import { leagueMeta, lineupShape, loadLeague } from '@/lib/league-data';
import { analyzeRoster } from '@/lib/roster-analysis';
import { requireSession } from '@/lib/session';
import { buildUsage } from '@/lib/usage';

/**
 * Your roster, priced by consequence.
 *
 * The organising idea is that a projection is not a contribution. A player who
 * projects for fifteen points behind someone who projects for eighteen at the
 * same position contributes nothing at all this week, and the column that
 * matters is what the lineup *loses* without him. Every ranking on this page is
 * by that number, and the projection is kept alongside so the gap between them
 * is visible — because that gap is exactly who you can afford to trade.
 */

const VERDICT_COLOR: Record<string, string> = {
  thin: 'var(--bad)',
  balanced: 'var(--ink-muted)',
  surplus: 'var(--good)',
};

export default async function RosterPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  const { snapshot, myTeamId } = view;

  const [analysis, { players: usageAll }, fragilityValues, fragilityPlayers, defenses, schemeFinding] =
    await Promise.all([
      myTeamId === null ? Promise.resolve(null) : analyzeRoster(view, myTeamId),
      buildUsage(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
      loadEdgePlayerValues(snapshot.league, snapshot.league.season, snapshot.asOfWeek),
      loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
      loadDefenses().catch(() => null),
      loadSchemeFinding().catch(() => null),
    ]);

  /*
   * The roster-level what-if (§60) needs the league on the wire, because the
   * simulation runs in the browser — N full seasons is not something to do on a
   * server render, and it only happens when a reader asks for it.
   *
   * Only starters are tested. Simulating the removal of a fourth-string tight
   * end costs the same as simulating a quarterback and answers nothing.
   */
  const fragilityWire = serializeLeague(view, fragilityValues, fragilityPlayers);
  const fragilityCandidates = (analysis?.players ?? [])
    .filter((player) => player.starting)
    .map((player) => ({ id: player.playerId, name: player.name }));

  const isDynasty = snapshot.league.format === 'dynasty' || snapshot.league.format === 'keeper';
  const usageOf = new Map(usageAll.map((player) => [player.playerId, player]));

  const maxMarginal = Math.max(...(analysis?.players.map((p) => p.marginal) ?? [1]), 1);
  const maxProjected = Math.max(...(analysis?.players.map((p) => p.projected) ?? [1]), 1);
  const maxValue = Math.max(...(analysis?.players.map((p) => p.value) ?? [1]), 1);

  const priced = analysis?.players.filter((p) => p.value > 0) ?? [];

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="roster"
        format={snapshot.league.format}
        stamps={
          analysis === null
            ? undefined
            : [
                { label: 'Players', value: String(analysis.players.length) },
                { label: 'Lineup', value: `${analysis.lineupTotal.toFixed(1)} pts` },
              ]
        }
      />

      <RailLayout
        rail={
          analysis === null ? null : (
            <>
              <RailBlock
                title="Roster shape"
                note="Top-two reliance is the fragility measure: a team drawing more than a third of its points from two players is one injury from collapse, whatever its record says."
              >
                <RailStat label="Starting lineup" value={`${analysis.lineupTotal.toFixed(1)} pts`} />
                <RailStat label="Top-two reliance" value={`${(analysis.topTwoShare * 100).toFixed(0)}%`} />
                {analysis.averageStarterAge !== null && (
                  <RailStat
                    label="Starter age"
                    value={`${analysis.averageStarterAge.toFixed(1)} yrs`}
                    hint="Value-weighted, so a bench of rookies does not disguise an old starting eleven."
                  />
                )}
                <RailStat label="Players" value={String(analysis.players.length)} />
              </RailBlock>

              <RailBlock
                title="How value is priced"
                note="Model value is what he produces above replacement; lineup loss is what he is worth to you. The gap between them is where trades are found."
              >
                <RailStat
                  label="Lineup loss"
                  value="per player"
                  hint="Points the optimal lineup gives up without him — his marginal value, not his projection."
                />
                <RailStat
                  label="Model"
                  value="Model"
                  hint="Dynasty or redraft, superflex-aware, matched to this league's format."
                />
              </RailBlock>
            </>
          )
        }
      >
        {analysis === null ? (
          <div className="panel p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            <strong style={{ color: 'var(--ink)' }}>No roster to analyse.</strong> Either the league
            hasn&apos;t drafted, or {session.username} isn&apos;t one of its managers.
          </div>
        ) : (
          <>
            <Section
              title="Your lineup’s strength depends on what sits behind it"
              note="Top-two reliance is the fragility measure: a team drawing more than a third of its points from two players is one injury from collapse, whatever its record says."
            >
              <StatRow columns={5}>
                <StatTile label="Starting lineup" value={analysis.lineupTotal.toFixed(1)} sub="projected points" />
                <StatTile
                  label="Top-two reliance"
                  value={formatPct(analysis.topTwoShare)}
                  sub="of your lineup"
                  tone={analysis.topTwoShare > 0.42 ? 'warn' : undefined}
                />
                <StatTile
                  label="Starter age"
                  value={analysis.averageStarterAge === null ? '—' : analysis.averageStarterAge.toFixed(1)}
                  sub={isDynasty ? 'contention window' : 'informational'}
                />
                <StatTile
                  label="Thin at"
                  value={
                    analysis.depth
                      .filter((d) => d.verdict === 'thin')
                      .map((d) => d.position)
                      .join(' ') || 'nothing'
                  }
                  tone={analysis.depth.some((d) => d.verdict === 'thin') ? 'bad' : 'good'}
                />
                <StatTile
                  label="Flagged"
                  value={String(analysis.players.filter((p) => p.injuryStatus !== null).length)}
                  sub="injury designations"
                  tone={analysis.players.some((p) => p.injuryStatus !== null) ? 'warn' : undefined}
                />
              </StatRow>
            </Section>

            {/* ---- contribution table --------------------------------- */}
            <Section
              title="Lineup loss, not projection, shows who matters"
              note={
                <>
                  Sorted by what the lineup loses without each player. The wide bar is that loss; the
                  pale bar behind the projection is what he scores whether or not it matters. When
                  those two disagree — a big projection and a short loss bar — you are looking at
                  somebody you can trade without weakening a thing.
                </>
              }
              aside={
                <Legend
                  items={[
                    { label: 'Lineup loses', color: 'var(--p-high)' },
                    { label: 'Projects', color: 'var(--p-low)' },
                  ]}
                />
              }
            >
              <div className="panel scroll-x">
                <table className="data-table" style={{ minWidth: '56rem' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '2rem' }} />
                      <th style={{ minWidth: '10rem' }}>Player</th>
                      <th>Status</th>
                      {/* Who each man plays, on the page listing all of them. */}
                      <th style={{ minWidth: '9rem' }}>Defense faced</th>
                      <th style={{ width: '7rem' }}>Lineup loses</th>
                      <th style={{ width: '9rem' }} title="25th / 50th / 75th weekly outcome points">p25 / p50 / p75</th>
                      <th className="text-right" title="Carries plus targets">
                        Opp
                      </th>
                      <th className="text-right" title="Share of projected points needing a touchdown">
                        TD-dep
                      </th>
                      <th className="text-right">Age</th>
                      <th style={{ width: '6rem' }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.players.map((player) => {
                      const usage = usageOf.get(player.playerId);

                      return (
                        <tr key={player.playerId} data-mine={player.starting}>
                          <td>
                            <PositionChip position={player.position} />
                          </td>
                          <td
                            className="max-w-[13rem] truncate"
                            style={{ fontWeight: player.starting ? 600 : 400 }}
                          >
                            {/* Every player name is a way into the evidence. A
                                projection you cannot interrogate is a number to
                                take on faith. */}
                            <Link
                              href={`/league/${leagueId}/player/${player.playerId}`}
                              className="hover:underline"
                            >
                              {player.name}
                            </Link>
                            <span className="ml-1.5 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                              {player.team}
                            </span>
                          </td>
                          <td
                            className="text-[11px]"
                            style={{ color: player.injuryStatus === null ? 'var(--ink-faint)' : 'var(--bad)' }}
                          >
                            {player.injuryStatus ?? (player.starting ? 'starting' : 'bench')}
                          </td>
                          <td>
                            <SchemeLine
                              compact
                              position={player.position}
                              opponent={opponentFrom(usage?.gameId ?? '', player.team)}
                              sd={player.sd ?? 0}
                              defenses={defenses}
                              finding={schemeFinding}
                              leagueId={leagueId}
                            />
                          </td>
                          <td>
                            <CellBar
                              value={player.marginal}
                              max={maxMarginal}
                              width={52}
                              color="var(--p-high)"
                              label={player.marginal < 0.05 ? '—' : player.marginal.toFixed(1)}
                            />
                          </td>
                          <td>
                            <div title="25th / 50th / 75th weekly outcome points">
                              <CellBar
                                value={player.p50}
                                max={maxProjected}
                                width={52}
                                color="var(--p-low)"
                                label={player.p50.toFixed(1)}
                              />
                              <div className="tabular mt-0.5 text-[10px]" style={{ color: 'var(--ink-faint)' }}>
                                {player.p25.toFixed(1)} / {player.p75.toFixed(1)}
                              </div>
                            </div>
                          </td>
                          <td className="tabular text-right" style={{ color: 'var(--ink-muted)' }}>
                            {usage === undefined || usage.opportunities === 0
                              ? '—'
                              : usage.opportunities.toFixed(1)}
                          </td>
                          <td
                            className="tabular text-right"
                            style={{
                              color:
                                (usage?.tdDependence ?? 0) > 0.35 ? 'var(--warn)' : 'var(--ink-faint)',
                            }}
                          >
                            {usage === undefined || usage.points === 0 ? '—' : formatPct(usage.tdDependence)}
                          </td>
                          <td className="tabular text-right" style={{ color: 'var(--ink-muted)' }}>
                            {player.age === null ? '—' : player.age.toFixed(1)}
                          </td>
                          <td>
                            <CellBar
                              value={player.value}
                              max={maxValue}
                              width={40}
                              color="var(--pos-qb)"
                              label={player.value > 0 ? player.value.toLocaleString() : '—'}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* ---- price against contribution -------------------------- */}
            {priced.length > 5 && (
              <Section
                title="The price tag and your lineup disagree about value"
                note={
                  <>
                    Model value on one axis, what your lineup would lose on the other. The two
                    disagree constantly, and the disagreement is where trades live. Bottom-right
                    is a sell: expensive to everyone else, replaceable to you. Top-left is a keep, and
                    a template for who to buy.
                  </>
                }
              >
                <div className="panel p-3">
                  <Scatter
                    xLabel="Model value →"
                    yLabel="Points your lineup loses →"
                    quadrantLabels={['Underpriced — keep', 'Core', 'Sell high', 'Fringe']}
                    points={priced.map((player) => ({
                      key: player.playerId,
                      x: player.value,
                      y: player.marginal,
                      label: `${player.name} (${player.position}) — ${player.value.toLocaleString()} value, lineup loses ${player.marginal.toFixed(1)}`,
                      color: positionColor(player.position),
                      radius: 4,
                      emphasis: player.starting,
                      href: `/league/${leagueId}/player/${player.playerId}`,
                    }))}
                  />
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                    Coloured by position; starters are outlined.
                  </p>
                </div>
              </Section>
            )}

            {/* ---- depth by position ----------------------------------- */}
            <Section
              title="Your thin spots are the positions with no replacement"
              note="How much of your lineup rests on each position, and how much of that would disappear with its best player. A position where the two bars are the same length is one player deep."
              aside={
                <Legend
                  items={[
                    { label: 'Lineup leans on it', color: 'var(--p-high)' },
                    { label: 'Exposed to top loss', color: 'var(--bad)' },
                  ]}
                />
              }
            >
              <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
                {[...analysis.depth]
                  .sort((a, b) => b.totalMarginal - a.totalMarginal)
                  .map((entry) => {
                    const max = Math.max(...analysis.depth.map((d) => d.totalMarginal), 1);

                    return (
                      <div key={entry.position} className="flex items-center gap-3 px-3 py-2">
                        <span className="w-9 shrink-0">
                          <PositionChip position={entry.position} />
                        </span>
                        <span
                          className="w-16 shrink-0 text-[11px] font-medium"
                          style={{ color: VERDICT_COLOR[entry.verdict] }}
                        >
                          {entry.verdict}
                        </span>
                        <span className="min-w-0 flex-1">
                          <StackedBar
                            max={max}
                            width={300}
                            height={13}
                            showLabels={false}
                            segments={[
                              {
                                key: 'exposed',
                                value: entry.exposureToTopLoss,
                                color: 'var(--bad)',
                              },
                              {
                                key: 'rest',
                                value: Math.max(0, entry.totalMarginal - entry.exposureToTopLoss),
                                color: 'var(--p-high)',
                              },
                            ]}
                          />
                        </span>
                        <span className="tabular w-12 shrink-0 text-right text-xs">
                          {entry.totalMarginal.toFixed(1)}
                        </span>
                        <span
                          className="tabular w-12 shrink-0 text-right text-xs"
                          style={{ color: 'var(--bad)' }}
                        >
                          −{entry.exposureToTopLoss.toFixed(1)}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </Section>

            {/* ---- buy / sell lists ------------------------------------ */}
            <div className="grid gap-3 lg:grid-cols-2">
              {analysis.sellCandidates.length > 0 && (
                <Section title="Bench depth is the safe trade capital">
                  <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
                    {analysis.sellCandidates.map((player) => (
                      <div key={player.playerId} className="flex items-center gap-2.5 px-3 py-2">
                        <PositionChip position={player.position} />
                        <span className="min-w-0 flex-1 truncate text-xs">{player.name}</span>
                        <span className="hidden text-[10px] sm:inline" style={{ color: 'var(--ink-faint)' }}>
                          bench · {player.projected.toFixed(1)} pts
                        </span>
                        <CellBar
                          value={player.value}
                          max={Math.max(...analysis.sellCandidates.map((p) => p.value), 1)}
                          width={70}
                          color="var(--good)"
                          label={player.value.toLocaleString()}
                        />
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {analysis.undervalued.length > 0 && (
                <Section
                  title="Some players are worth more to you than their price"
                  note="Priced cheap for what they do here. Keep, or buy more like them."
                >
                  <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
                    {analysis.undervalued.map((player) => (
                      <div key={player.playerId} className="flex items-center gap-2.5 px-3 py-2">
                        <PositionChip position={player.position} />
                        <span className="min-w-0 flex-1 truncate text-xs">{player.name}</span>
                        <span className="tabular shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
                          {player.valuePerPoint === null ? '—' : `${Math.round(player.valuePerPoint)} / pt`}
                        </span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </div>

            {/* ---- age curve ------------------------------------------- */}
            {isDynasty && analysis.players.some((player) => player.age !== null) && (
              <Section
                title="Age changes the price of every dynasty asset"
                note={
                  <>
                    In dynasty the only question that matters is <em>when</em>. Each dot is a player;
                    the further right, the closer to the end of his window. A roster whose value all
                    sits on the right is a team that has to win now, whether or not it wants to.
                  </>
                }
              >
                <div className="panel p-3">
                  <Scatter
                    xLabel="Age →"
                    yLabel="Model value →"
                    quadrantLabels={['Young assets', 'Peak, aging', 'Declining', 'Young, cheap']}
                    points={analysis.players
                      .filter((player) => player.age !== null && player.value > 0)
                      .map((player) => ({
                        key: player.playerId,
                        x: player.age ?? 0,
                        y: player.value,
                        label: `${player.name} (${player.position}) — ${(player.age ?? 0).toFixed(1)} yrs, ${player.value.toLocaleString()}`,
                        color: positionColor(player.position),
                        radius: 3.5 + Math.min(player.marginal, 8) * 0.35,
                        emphasis: player.starting,
                        href: `/league/${leagueId}/player/${player.playerId}`,
                      }))}
                  />
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                    Dot size is what your lineup loses without him.
                  </p>
                </div>
              </Section>
            )}

            {/* ---- usage detail ---------------------------------------- */}
            {analysis.players.some((player) => (usageOf.get(player.playerId)?.opportunities ?? 0) > 0) && (
              <Section
                title="Usage explains the points your players project"
                note="The volume behind each projection. Carries and targets are what repeat; yards and touchdowns are what regress toward them."
                aside={
                  <Legend
                    items={[
                      { label: 'Carries', color: 'var(--pos-rb)' },
                      { label: 'Targets', color: 'var(--pos-wr)' },
                    ]}
                  />
                }
              >
                <div className="panel scroll-x">
                  <table className="data-table" style={{ minWidth: '46rem' }}>
                    <thead>
                      <tr>
                        <th style={{ width: '2rem' }} />
                        <th style={{ minWidth: '10rem' }}>Player</th>
                        <th style={{ width: '10rem' }}>Opportunity</th>
                        <th className="text-right">Tgt%</th>
                        <th className="text-right">Car%</th>
                        <th className="text-right">Y/T</th>
                        <th className="text-right">Y/C</th>
                        <th className="text-right">Yds</th>
                        <th className="text-right">Pts/opp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.players
                        .map((player) => ({ player, usage: usageOf.get(player.playerId) }))
                        .filter(
                          (row): row is { player: (typeof analysis.players)[number]; usage: NonNullable<typeof row.usage> } =>
                            row.usage !== undefined && row.usage.opportunities > 0,
                        )
                        .sort((a, b) => b.usage.opportunities - a.usage.opportunities)
                        .map(({ player, usage }) => (
                          <tr key={player.playerId} data-mine={player.starting}>
                            <td>
                              <PositionChip position={player.position} />
                            </td>
                            <td className="max-w-[13rem] truncate">{player.name}</td>
                            <td>
                              <StackedBar
                                max={Math.max(
                                  ...analysis.players.map(
                                    (p) => usageOf.get(p.playerId)?.opportunities ?? 0,
                                  ),
                                  1,
                                )}
                                width={150}
                                height={13}
                                showLabels={false}
                                segments={[
                                  { key: 'Carries', value: usage.carries, color: 'var(--pos-rb)' },
                                  { key: 'Targets', value: usage.targets, color: 'var(--pos-wr)' },
                                ]}
                              />
                            </td>
                            <td className="tabular text-right">{formatPct(usage.targetShare)}</td>
                            <td className="tabular text-right">{formatPct(usage.carryShare)}</td>
                            <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
                              {usage.yardsPerTarget === null ? '—' : usage.yardsPerTarget.toFixed(1)}
                            </td>
                            <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
                              {usage.yardsPerCarry === null ? '—' : usage.yardsPerCarry.toFixed(1)}
                            </td>
                            <td className="tabular text-right">{usage.yardsFromScrimmage.toFixed(0)}</td>
                            <td className="tabular text-right font-semibold">
                              {usage.pointsPerOpportunity === null
                                ? '—'
                                : usage.pointsPerOpportunity.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}
          </>
        )}

        {myTeamId !== null && fragilityCandidates.length > 0 && (
          <Section
            title="The fragility test shows what can break this season"
            source="2,000 season simulations · model v1-usage+positional"
            note="The other what-if asks how a player's role might change. This asks what happens if he is gone — a different question, because the answer is about your roster rather than about him."
          >
            <Fragility
              wire={fragilityWire}
              myTeamId={myTeamId}
              candidates={fragilityCandidates}
            />
          </Section>
        )}

      </RailLayout>
    </>
  );
}
