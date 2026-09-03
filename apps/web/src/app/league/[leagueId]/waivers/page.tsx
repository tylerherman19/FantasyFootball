import { LeagueNav } from '@/components/LeagueNav';
import { SchemeLine } from '@/components/SchemeLine';
import { loadDefenses, opponentFrom } from '@/lib/defense';
import { loadSchemeFinding } from '@/lib/scheme-impact';
import { RailBlock, RailLayout } from '@/components/design/DrillRail';
import { LeagueRail } from '@/components/design/LeagueRail';
import { Section } from '@/components/Section';
import { WaiverBoard } from '@/components/WaiverBoard';
import {
  Legend,
  PositionChip,
  StackedBar,
  formatPct,
} from '@/components/charts/primitives';
import { requireSession } from '@/lib/session';
import { buildUsage } from '@/lib/usage';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { loadFreeAgents, waiverBudgetFor } from '@/lib/waiver-data';
import { serializeLeague } from '@/lib/serialize';
import { loadEdgePlayerValues } from '@/lib/edge-values';

export default async function WaiversPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);

  if (view.myTeamId === null) {
    return <main className="mx-auto max-w-5xl px-6 py-12">Could not find your team in this league.</main>;
  }

  const myTeamId = view.myTeamId;
  const { snapshot } = view;

  const [values, players, freeAgents, defenses, schemeFinding] = await Promise.all([
    loadEdgePlayerValues(snapshot.league, snapshot.league.season, snapshot.asOfWeek),
    loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
    loadFreeAgents(view, view.myTeamId),
    loadDefenses().catch(() => null),
    loadSchemeFinding().catch(() => null),
  ]);

  const budget = waiverBudgetFor(snapshot, myTeamId);
  const wire = serializeLeague(view, values, players, [], freeAgents, budget);

  const { players: usageAll } = await buildUsage(
    snapshot.league.season,
    snapshot.asOfWeek,
    snapshot.league.scoring.raw,
  );
  const usageOf = new Map(usageAll.map((player) => [player.playerId, player]));

  /**
   * The wire, by opportunity rather than by points.
   *
   * Points on the waiver wire are mostly noise — one touchdown separates the
   * top of the list from the middle. Volume is the signal that a role has
   * actually changed hands, and a role change is the only thing on the wire
   * genuinely worth bidding on.
   */
  const byOpportunity = freeAgents
    .map((agent) => ({ agent, usage: usageOf.get(agent.id) }))
    .filter(
      (row): row is { agent: (typeof freeAgents)[number]; usage: NonNullable<typeof row.usage> } =>
        row.usage !== undefined && row.usage.opportunities > 1,
    )
    .sort((a, b) => b.usage.opportunities - a.usage.opportunities)
    .slice(0, 15);

  const maxOpportunities = Math.max(...byOpportunity.map((row) => row.usage.opportunities), 1);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="waivers"
        format={snapshot.league.format}
        stamps={[
          { label: 'Free agents', value: freeAgents.length.toLocaleString() },
          ...(snapshot.league.waiverType === 'faab'
            ? [{ label: 'FAAB left', value: String(budget) }]
            : []),
        ]}
      />

      <RailLayout
        rail={
          <LeagueRail view={view}>
            <RailBlock title="What this page answers">
              Every free agent is ranked by what he does for your roster specifically, with the bid sized from that edge rather than from a generic ranking.
            </RailBlock>
          </LeagueRail>
        }
      >
        {/*
         * What this board is, before the board.
         *
         * The ranking is the unusual thing here and it is invisible until
         * explained: free agents are ordered by what they add to *this* lineup,
         * not by projected points. Without saying so, a reader sees a receiver
         * above a higher-projected quarterback and concludes the page is wrong,
         * when it is being right in the way that matters.
         */}
        <div
          className="mb-5 border-l-2 px-4 py-3 text-sm leading-relaxed"
          style={{ borderColor: 'var(--accent)', background: 'var(--surface-sunk)' }}
        >
          <strong>
            {freeAgents.length} free {freeAgents.length === 1 ? 'agent' : 'agents'} worth screening,
            ranked by what they add to your lineup.
          </strong>{' '}
          <span style={{ color: 'var(--ink-muted)' }}>
            Not by projected points — a third quarterback out-projects most receivers and cannot
            crack a lineup already starting two, so he is worth approximately nothing to you.
            {budget.seasonBudget > 0
              ? ` You have $${budget.remainingBudget} of $${budget.seasonBudget} FAAB left.`
              : ' This league runs waiver priority, so there is no bid to size.'}{' '}
            Choose what you are willing to drop below, then rank the wire against that.
          </span>
        </div>
        {byOpportunity.length > 0 && (
          <Section
            title="Volume on the wire"
            source="model v1-usage+positional · projections rebuilt weekly"
            note={
              <>
                Available players ranked by projected opportunity — carries plus targets — rather
                than by points. One touchdown separates the top of a points-sorted wire from the
                middle of it; a role does not move that easily, which is why this is the list that
                tends to be right.
              </>
            }
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
              <table className="data-table" style={{ minWidth: '44rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '2rem' }} />
                    <th style={{ minWidth: '10rem' }}>Player</th>
                    <th>Tm</th>
                    <th style={{ width: '11rem' }}>Opportunity</th>
                    <th className="text-right">Opp</th>
                    <th className="text-right">Tgt%</th>
                    <th className="text-right">Car%</th>
                    <th className="text-right">Pts</th>
                    <th className="text-right">TD-dep</th>
                    {/*
                      * Who he plays, in the table where you decide whether to
                      * spend on him. Compact on purpose — the headline plus a
                      * hover carrying the detail and the bound, because a
                      * waiver list is scanned rather than read.
                      */}
                    <th style={{ minWidth: '9rem' }}>This week&rsquo;s defense</th>
                  </tr>
                </thead>
                <tbody>
                  {byOpportunity.map(({ agent, usage }) => (
                    <tr key={agent.id}>
                      <td>
                        <PositionChip position={usage.position} />
                      </td>
                      <td className="max-w-[13rem] truncate">{usage.name}</td>
                      <td className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                        {usage.team}
                      </td>
                      <td>
                        <StackedBar
                          max={maxOpportunities}
                          width={170}
                          height={13}
                          showLabels={false}
                          segments={[
                            { key: 'Carries', value: usage.carries, color: 'var(--pos-rb)' },
                            { key: 'Targets', value: usage.targets, color: 'var(--pos-wr)' },
                          ]}
                        />
                      </td>
                      <td className="tabular text-right font-semibold">{usage.opportunities.toFixed(1)}</td>
                      <td className="tabular text-right">{formatPct(usage.targetShare)}</td>
                      <td className="tabular text-right">{formatPct(usage.carryShare)}</td>
                      <td className="tabular text-right">{usage.points.toFixed(1)}</td>
                      <td
                        className="tabular text-right"
                        style={{ color: usage.tdDependence > 0.35 ? 'var(--warn)' : 'var(--ink-faint)' }}
                      >
                        {formatPct(usage.tdDependence)}
                      </td>
                      <td>
                        <SchemeLine
                          compact
                          position={usage.position}
                          opponent={opponentFrom(usage.gameId, usage.team)}
                          sd={players[usage.playerId]?.sd ?? 0}
                          defenses={defenses}
                          finding={schemeFinding}
                          leagueId={leagueId}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        <Section
          title="Ranked by what they do to your odds"
            source="2,000 season simulations · model v1-usage+positional"
          note={
            <>
              Not by projected points. A backup running back is worth a lot to the manager whose
              starter just went down and nothing to everyone else — same player, same projection.
              Choose what you&apos;re willing to drop and the board re-ranks against that.
            </>
          }
        >
          <WaiverBoard league={wire} myTeamId={myTeamId} />
        </Section>
      </RailLayout>
    </>
  );
}
