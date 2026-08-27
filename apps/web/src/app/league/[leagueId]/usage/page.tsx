import { LeagueNav } from '@/components/LeagueNav';
import { RailBlock, RailLayout } from '@/components/design/DrillRail';
import { LeagueRail } from '@/components/design/LeagueRail';
import { Section, StatRow, StatTile } from '@/components/Section';
import {
  CellBar,
  Legend,
  LineChart,
  PositionChip,
  Scatter,
  StackedBar,
  formatPct,
  positionColor,
} from '@/components/charts/primitives';
import { leagueMeta, lineupShape, loadLeague } from '@/lib/league-data';
import { requireSession } from '@/lib/session';
import { buildUsage, positionCurve, replacementLevel, type PlayerUsage } from '@/lib/usage';

/**
 * The volume underneath every projection.
 *
 * A projection is a conclusion. This page is the evidence: how many times a
 * player is expected to touch the ball, what share of his own offense that is,
 * how much of his scoring depends on reaching the end zone, and what kind of
 * offense he plays in. It is the difference between "12.4 points" and knowing
 * whether that number will still be there next week.
 *
 * All of it is arithmetic over the artifact the model already exports — no
 * second data source, no second opinion, and no cost beyond reading a file the
 * page had loaded anyway.
 */

const FLOOR = 4; // Points below which a player is noise rather than a decision.

export default async function UsagePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  const { snapshot } = view;

  const { players, offenses } = await buildUsage(
    snapshot.league.season,
    snapshot.asOfWeek,
    snapshot.league.scoring.raw,
  );

  if (players.length === 0) {
    return (
      <>
        <LeagueNav
          leagueId={leagueId}
          leagueName={snapshot.league.name}
          meta={leagueMeta(snapshot)}
          active="usage"
          format={snapshot.league.format}
        />
        <main className="mx-auto max-w-6xl px-5 pb-20 lg:pl-[4.75rem]">
        </main>
      </>
    );
  }

  const relevant = players.filter((player) => player.active && player.points >= FLOOR);

  // Who is on a roster in this league, so the same numbers can be read as
  // "available" or "already owned" without leaving the page.
  const rostered = new Set(snapshot.rosters.flatMap((roster) => roster.playerIds.map(String)));
  const myRoster = new Set(
    snapshot.rosters.find((roster) => roster.teamId === view.myTeamId)?.playerIds.map(String) ?? [],
  );

  const startersPerTeam = (position: string): number =>
    snapshot.league.rosterSlots.filter((slot) => slot === position).length;

  const skillPositions = ['QB', 'RB', 'WR', 'TE'] as const;

  const replacement = Object.fromEntries(
    skillPositions.map((position) => [
      position,
      replacementLevel(players, position, snapshot.league.teamCount * Math.max(startersPerTeam(position), 1)),
    ]),
  ) as Record<string, number>;

  const topByOpportunity = [...relevant]
    .filter((player) => player.opportunities > 0)
    .sort((a, b) => b.opportunities - a.opportunities)
    .slice(0, 24);

  const maxOpportunities = Math.max(...topByOpportunity.map((p) => p.opportunities), 1);

  const passCatchers = relevant.filter(
    (player) => (player.position === 'WR' || player.position === 'TE' || player.position === 'RB') && player.targets >= 3,
  );

  const maxPlays = Math.max(...offenses.map((offense) => offense.plays), 1);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="usage"
        format={snapshot.league.format}
        stamps={[
          { label: 'Players', value: players.length.toLocaleString() },
          { label: 'Offenses', value: String(offenses.length) },
          { label: 'Week', value: String(snapshot.asOfWeek) },
        ]}
      />

        <RailLayout
        rail={
          <LeagueRail view={view}>
            <RailBlock title="What this page answers">
              Volume is sticky and efficiency is noise. That asymmetry is the whole reason this model beats a points average.
            </RailBlock>
          </LeagueRail>
        }
      >
          <div className="panel p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No projection artifact for {snapshot.league.season} week {snapshot.asOfWeek}, so there is
            no usage to show. The model writes one per week; this page reads whatever is there.
          </div>
        <Section
          title="Opportunity is the signal beneath every projection"
          note={
            <>
              Every number here is scored under <strong>this league&apos;s</strong> rules and derived
              from the model&apos;s projected stat lines — targets, carries, receptions, yards,
              touchdowns — rather than from a points total. Volume is what repeats week to week;
              efficiency and touchdowns are what regress. When those two disagree about a player,
              that disagreement is the edge.
            </>
          }
        >
          <StatRow columns={4}>
            <StatTile
              label="Replacement QB"
              value={replacement.QB?.toFixed(1) ?? '—'}
              sub={`${snapshot.league.teamCount * Math.max(startersPerTeam('QB'), 1)} starters league-wide`}
            />
            <StatTile
              label="Replacement RB"
              value={replacement.RB?.toFixed(1) ?? '—'}
              sub="points above this are what a slot is worth"
            />
            <StatTile label="Replacement WR" value={replacement.WR?.toFixed(1) ?? '—'} sub="same basis" />
            <StatTile
              label="Replacement TE"
              value={replacement.TE?.toFixed(1) ?? '—'}
              sub="the thinnest position in most leagues"
            />
          </StatRow>
        </Section>

        {/* ---- opportunity leaderboard --------------------------------- */}
        <Section
          title="These players control the most opportunity"
            source="model v1-usage+positional · projections rebuilt weekly"
          note={
            <>
              Carries plus targets — everything that can turn into production. This is the most
              stable thing about a player and the first place a change of role shows up, long before
              the points move. Highlighted rows are yours; anyone marked <strong>FA</strong> is
              unrostered in this league and can be claimed.
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
            <table className="data-table" style={{ minWidth: '54rem' }}>
              <thead>
                <tr>
                  <th style={{ width: '2rem' }} />
                  <th style={{ minWidth: '10rem' }}>Player</th>
                  <th>Tm</th>
                  <th style={{ width: '11rem' }}>Opportunity split</th>
                  <th className="text-right">Opp</th>
                  <th className="text-right">Tgt%</th>
                  <th className="text-right">Car%</th>
                  <th className="text-right">Yds</th>
                  <th className="text-right">Pts</th>
                  <th className="text-right" title="Share of projected points that requires a touchdown">
                    TD-dep
                  </th>
                </tr>
              </thead>
              <tbody>
                {topByOpportunity.map((player) => (
                  <tr key={player.playerId} data-mine={myRoster.has(player.playerId)}>
                    <td>
                      <PositionChip position={player.position} />
                    </td>
                    <td
                      className="max-w-[13rem] truncate"
                      style={{ opacity: rostered.has(player.playerId) ? 1 : 0.72 }}
                    >
                      {player.name}
                      {!rostered.has(player.playerId) && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--good)' }}>
                          FA
                        </span>
                      )}
                    </td>
                    <td className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                      {player.team}
                    </td>
                    <td>
                      <StackedBar
                        max={maxOpportunities}
                        width={170}
                        height={13}
                        showLabels={false}
                        segments={[
                          { key: 'Carries', value: player.carries, color: 'var(--pos-rb)' },
                          { key: 'Targets', value: player.targets, color: 'var(--pos-wr)' },
                        ]}
                      />
                    </td>
                    <td className="tabular text-right font-semibold">{player.opportunities.toFixed(1)}</td>
                    <td className="tabular text-right">{formatPct(player.targetShare)}</td>
                    <td className="tabular text-right">{formatPct(player.carryShare)}</td>
                    <td className="tabular text-right">{player.yardsFromScrimmage.toFixed(0)}</td>
                    <td className="tabular text-right font-semibold">{player.points.toFixed(1)}</td>
                    <td
                      className="tabular text-right"
                      style={{ color: player.tdDependence > 0.35 ? 'var(--warn)' : 'var(--ink-faint)' }}
                    >
                      {formatPct(player.tdDependence)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ---- opportunity vs production ------------------------------- */}
        {passCatchers.length > 6 && (
          <Section
            title="Volume is not converting evenly"
            note={
              <>
                Targets on one axis, projected points on the other. The line through the middle is
                the league median for each. Bottom-right is the interesting quadrant: players
                producing without the volume to back it up, which usually means touchdowns doing the
                work. Top-left is the opposite — volume not yet converting, which is the profile that
                tends to be underpriced.
              </>
            }
          >
            <div className="panel p-3">
              <Scatter
                xLabel="Projected targets →"
                yLabel="Projected points →"
                quadrantLabels={[
                  'Volume, low output',
                  'Volume and output',
                  'Output on low volume',
                  'Neither',
                ]}
                points={passCatchers.map((player) => ({
                  key: player.playerId,
                  x: player.targets,
                  y: player.points,
                  label: `${player.name} (${player.position}, ${player.team}) — ${player.targets.toFixed(1)} tgt, ${player.points.toFixed(1)} pts, ${formatPct(player.tdDependence)} TD-dependent`,
                  color: myRoster.has(player.playerId) ? 'var(--accent)' : positionColor(player.position),
                  emphasis: myRoster.has(player.playerId),
                  radius: 3.5,
                  href: `/league/${leagueId}/player/${player.playerId}`,
                }))}
              />
              <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                Coloured by position. Your players are outlined.
              </p>
            </div>
          </Section>
        )}

        {/* ---- positional scarcity ------------------------------------- */}
        <Section
          title="Replacement cliffs show where points are scarce"
          note={
            <>
              Projected points by rank at each position. The steepness is the whole argument: where a
              curve falls off a cliff, the top few players are worth far more than their point totals
              suggest, and where it stays flat, paying up is wasted. The marks show where replacement
              level falls in <em>this</em> league, given {snapshot.league.teamCount} teams and its
              starting requirements.
            </>
          }
          aside={<Legend items={skillPositions.map((p) => ({ label: p, color: positionColor(p) }))} />}
        >
          <div className="panel p-3">
            <LineChart
              xLabel="Rank at position"
              yFormat={(value) => value.toFixed(0)}
              height={240}
              series={skillPositions.map((position) => ({
                key: position,
                label: position,
                color: positionColor(position),
                emphasis: true,
                points: positionCurve(players, position, 40).map((points, index) => ({
                  x: index + 1,
                  y: points,
                })),
              }))}
              markLast={false}
            />
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              {skillPositions.map((position) => {
                const curve = positionCurve(players, position, 40);
                const starters = snapshot.league.teamCount * Math.max(startersPerTeam(position), 1);
                const top = curve[0] ?? 0;
                const cliff = curve[Math.min(curve.length - 1, starters - 1)] ?? 0;

                return (
                  <div key={position} className="rounded p-2" style={{ background: 'var(--surface-sunk)' }}>
                    <div className="flex items-center gap-1.5">
                      <PositionChip position={position} />
                      <span className="tabular text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                        #1 → #{starters}
                      </span>
                    </div>
                    <div className="tabular mt-1 text-sm font-semibold">
                      −{(top - cliff).toFixed(1)} pts
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                      {top > 0 ? formatPct((top - cliff) / top) : '—'} drop to the last starter
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Section>

        {/* ---- NFL offenses -------------------------------------------- */}
        {offenses.length > 0 && (
          <Section
            title="Every offense distributes opportunity differently"
            note={
              <>
                How each offense is projected to distribute the ball. <strong>Pass lean</strong> is
                dropbacks as a share of plays — the clearest single read on what a team wants to do,
                and what a defense that stops one thing forces them into. <strong>Target
                concentration</strong> is a Herfindahl index: high means one receiver eats and his
                teammates are traps, low means the work is spread and nobody is safe.
                <br />
                <span style={{ color: 'var(--ink-faint)' }}>
                  Volume totals sum every rostered player&apos;s projection including backups who
                  probably won&apos;t play, so they run above a real box score. The ratios are the
                  comparable part; the counts are the denominator behind them.
                </span>
              </>
            }
            aside={
              <Legend
                items={[
                  { label: 'Pass', color: 'var(--pos-wr)' },
                  { label: 'Run', color: 'var(--pos-rb)' },
                ]}
              />
            }
          >
            <div className="panel scroll-x">
              <table className="data-table" style={{ minWidth: '48rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '3rem' }}>Tm</th>
                    <th style={{ width: '13rem' }}>Pass / run split</th>
                    <th className="text-right">Pass lean</th>
                    <th className="text-right">Volume</th>
                    <th className="text-right" title="Herfindahl index over target share">
                      Concentration
                    </th>
                    <th style={{ minWidth: '9rem' }}>Lead target</th>
                    <th className="text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {[...offenses]
                    .sort((a, b) => b.passRate - a.passRate)
                    .map((offense) => (
                      <tr key={offense.team}>
                        <td className="font-semibold">{offense.team}</td>
                        <td>
                          <StackedBar
                            max={1}
                            width={200}
                            height={13}
                            showLabels={false}
                            segments={[
                              { key: 'Pass', value: offense.passRate, color: 'var(--pos-wr)' },
                              { key: 'Run', value: 1 - offense.passRate, color: 'var(--pos-rb)' },
                            ]}
                          />
                        </td>
                        <td className="tabular text-right font-semibold">{formatPct(offense.passRate, 1)}</td>
                        <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
                          <CellBar
                            value={offense.plays}
                            max={maxPlays}
                            width={40}
                            color="var(--p-mid)"
                            label={offense.plays.toFixed(0)}
                          />
                        </td>
                        <td className="tabular text-right">{offense.targetConcentration.toFixed(3)}</td>
                        <td className="max-w-[11rem] truncate text-xs">{offense.topTargetName ?? '—'}</td>
                        <td className="tabular text-right">{formatPct(offense.topTargetShare, 1)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* ---- efficiency table ---------------------------------------- */}
        <Section
            title="Efficiency is the least stable part of the forecast"
          note={
            <>
              Points per carry-or-target, for players with enough volume to mean it. High efficiency
              on low volume is the least durable thing in fantasy football — it is the profile that
              looks like a breakout and is usually a hot streak. High efficiency on high volume is
              the real thing.
            </>
          }
        >
          <EfficiencyTable
            players={relevant.filter((player) => player.pointsPerOpportunity !== null)}
            mine={myRoster}
          />
        </Section>
      </RailLayout>
    </>
  );
}

/**
 * Split into its own component so the two halves — best and worst rate per
 * opportunity — read as one comparison rather than two lists.
 */
const EfficiencyTable = ({
  players,
  mine,
}: {
  players: readonly PlayerUsage[];
  mine: ReadonlySet<string>;
}) => {
  const sorted = [...players].sort(
    (a, b) => (b.pointsPerOpportunity ?? 0) - (a.pointsPerOpportunity ?? 0),
  );
  const best = sorted.slice(0, 12);
  const worst = sorted.slice(-8).reverse();
  const max = Math.max(...sorted.map((player) => player.pointsPerOpportunity ?? 0), 1);

  const rows = (list: readonly PlayerUsage[]) =>
    list.map((player) => (
      <tr key={player.playerId} data-mine={mine.has(player.playerId)}>
        <td>
          <PositionChip position={player.position} />
        </td>
        <td className="max-w-[12rem] truncate">{player.name}</td>
        <td className="text-xs" style={{ color: 'var(--ink-faint)' }}>
          {player.team}
        </td>
        <td className="tabular text-right">{player.opportunities.toFixed(1)}</td>
        <td>
          <CellBar
            value={player.pointsPerOpportunity ?? 0}
            max={max}
            width={70}
            color={positionColor(player.position)}
            label={(player.pointsPerOpportunity ?? 0).toFixed(2)}
          />
        </td>
        <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
          {player.yardsPerTarget === null ? '—' : player.yardsPerTarget.toFixed(1)}
        </td>
        <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
          {player.yardsPerCarry === null ? '—' : player.yardsPerCarry.toFixed(1)}
        </td>
      </tr>
    ));

  const head = (
    <thead>
      <tr>
        <th style={{ width: '2rem' }} />
        <th style={{ minWidth: '9rem' }}>Player</th>
        <th>Tm</th>
        <th className="text-right">Opp</th>
        <th style={{ width: '8rem' }}>Pts / opp</th>
        <th className="text-right" title="Receiving yards per target">
          Y/T
        </th>
        <th className="text-right" title="Rushing yards per carry">
          Y/C
        </th>
      </tr>
    </thead>
  );

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="panel scroll-x">
        <div className="panel-head">
          <span className="eyebrow">Most per touch</span>
        </div>
        <table className="data-table" style={{ minWidth: '30rem' }}>
          {head}
          <tbody>{rows(best)}</tbody>
        </table>
      </div>

      <div className="panel scroll-x">
        <div className="panel-head">
          <span className="eyebrow">Least per touch</span>
        </div>
        <table className="data-table" style={{ minWidth: '30rem' }}>
          {head}
          <tbody>{rows(worst)}</tbody>
        </table>
      </div>
    </div>
  );
};
