import { LeagueNav } from '@/components/LeagueNav';
import { Section, StatRow, StatTile } from '@/components/Section';
import {
  CellBar,
  DivergingBar,
  Legend,
  PositionChip,
  Scatter,
  formatPct,
  positionColor,
} from '@/components/charts/primitives';
import { buildDynastyView, type DynastyAsset } from '@/lib/dynasty';
import { analysePortfolio, portfolioRead, type PortfolioPlayer } from '@/lib/portfolio';
import { loadArtifact } from '@/lib/projections';
import { loadMarketValues } from '@/lib/values';
import { reliabilityLabel, trendLabel } from '@/lib/history';
import { leagueMeta, lineupShape, loadLeague } from '@/lib/league-data';
import { requireSession } from '@/lib/session';

/**
 * What to do about it.
 *
 * Every other page here measures. This one decides. The verdict comes from two
 * axes and nothing else — whether you can win now, and how long you can keep
 * winning — because everything else a manager worries about is downstream of
 * those two, and treating "good" and "young" as the same axis is the mistake
 * that keeps teams stuck in the middle for three years.
 */

const STANCE_COLOR: Record<string, string> = {
  'win-now': 'var(--accent)',
  contend: 'var(--good)',
  retool: 'var(--warn)',
  rebuild: 'var(--p-high)',
};

export default async function DynastyPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  const { snapshot, myTeamId } = view;

  const dynasty = myTeamId === null ? null : await buildDynastyView(view, myTeamId);

  /*
   * The roster as correlated assets (§23). Everything else on this page treats
   * players as independent, and two men in the same offence are not — when that
   * offence has a bad Sunday they have it together, which a sum of values
   * structurally cannot show.
   */
  const [portfolioArtifact, portfolioValues] = await Promise.all([
    loadArtifact(view.snapshot.league.season, view.snapshot.asOfWeek),
    loadMarketValues(view.snapshot.league.format, view.snapshot.league.superFlex),
  ]);
  const myRoster = view.snapshot.rosters.find((r) => r.teamId === myTeamId);
  const portfolio =
    myRoster === undefined || portfolioArtifact === null
      ? null
      : analysePortfolio(
          myRoster.playerIds.flatMap((rawId): PortfolioPlayer[] => {
            const id = String(rawId);
            const p = portfolioArtifact.players[id];
            if (p === undefined) return [];
            return [
              {
                playerId: id,
                name: p.name,
                position: p.position,
                team: p.team,
                mean: 0,
                sd: p.sd,
                gameId: p.gameId,
                gameLoading: p.gameLoading,
                marketValue: portfolioValues.get(id)?.value ?? 0,
              },
            ];
          }),
        );

  const nav = (
    <LeagueNav
      leagueId={leagueId}
      leagueName={snapshot.league.name}
      meta={leagueMeta(snapshot)}
      lineupShape={lineupShape(snapshot)}
      active="dynasty"
      format={snapshot.league.format}
      stamps={
        dynasty === null
          ? undefined
          : [
              { label: 'Roster value', value: dynasty.totalValue.toLocaleString() },
              { label: 'Stance', value: dynasty.verdict.stance },
            ]
      }
    />
  );

  if (dynasty === null) {
    return (
      <>
        {nav}
        <main className="mx-auto max-w-6xl px-5 pb-20 lg:pl-[4.75rem]">
          <div className="panel p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            <strong style={{ color: 'var(--ink)' }}>No team to advise.</strong> Either the league
            hasn&apos;t drafted, or {session.username} isn&apos;t one of its managers.
          </div>


        </main>
      </>
    );
  }

  const { verdict, profile } = dynasty;
  const stanceColor = STANCE_COLOR[verdict.stance] ?? 'var(--ink)';

  const maxAgeBand = Math.max(...dynasty.valueByAge.map((band) => band.value), 1);
  const withHistory = dynasty.assets.filter((asset) => asset.history !== null);

  return (
    <>
      {nav}

      <main className="mx-auto max-w-6xl px-5 pb-20 lg:pl-[4.75rem]">
        {/* ---- the verdict ------------------------------------------------ */}
        <section className="mb-9">
          <div className="panel overflow-hidden">
            <div
              className="px-4 py-3"
              style={{ background: 'var(--surface-sunk)', borderBottom: '1px solid var(--rule)' }}
            >
              <div className="eyebrow" style={{ color: stanceColor }}>
                {verdict.stance.replace('-', ' ')}
              </div>
              <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
                {verdict.headline}
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                {verdict.reasoning}
              </p>
            </div>

            <div className="grid gap-px sm:grid-cols-2" style={{ background: 'var(--rule)' }}>
              {[
                ['Do now', verdict.shortTerm],
                ['Do over the next two seasons', verdict.longTerm],
              ].map(([title, items]) => (
                <div key={String(title)} className="p-4" style={{ background: 'var(--surface)' }}>
                  <div className="eyebrow mb-2">{String(title)}</div>
                  <ul className="space-y-1.5">
                    {(items as string[]).map((item) => (
                      <li key={item} className="flex gap-2 text-[13px] leading-relaxed">
                        <span aria-hidden="true" style={{ color: stanceColor }}>
                          →
                        </span>
                        <span style={{ color: 'var(--ink-muted)' }}>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- team value ------------------------------------------------- */}
        <Section
          title="What your team is worth"
          note={
            <>
              Market value is what other managers would actually pay, from trades executed in real
              Sleeper leagues — not a ranking. It is the only currency a trade is settled in, which
              is why it sits next to the age bands rather than on its own: the same total means very
              different things depending on how old it is.
            </>
          }
        >
          <StatRow columns={5}>
            <StatTile
              label="Roster value"
              value={dynasty.totalValue.toLocaleString()}
              sub={`league median ${dynasty.leagueMedianValue.toLocaleString()}`}
              tone={dynasty.totalValue >= dynasty.leagueMedianValue ? 'good' : 'bad'}
            />
            <StatTile
              label="Title odds"
              value={formatPct(profile.titlePct, 1)}
              sub={`even share ${formatPct(1 / snapshot.league.teamCount, 1)}`}
              emphasis
            />
            <StatTile
              label="Roster age"
              value={profile.averageAge === null ? '—' : profile.averageAge.toFixed(1)}
              sub={`league median ${dynasty.leagueMedianAge.toFixed(1)}`}
              tone={
                profile.averageAge === null
                  ? undefined
                  : profile.averageAge <= dynasty.leagueMedianAge
                    ? 'good'
                    : 'warn'
              }
            />
            <StatTile
              label="Value under 26"
              value={formatPct(
                dynasty.valueByAge
                  .filter((band) => band.band === 'Under 24' || band.band === '24–26')
                  .reduce((sum, band) => sum + band.value, 0) / Math.max(dynasty.totalValue, 1),
              )}
              sub="of roster value"
            />
            <StatTile
              label="Starter points"
              value={profile.starterPoints.toFixed(1)}
              sub="per week, optimal lineup"
            />
          </StatRow>
        </Section>

        {/* ---- value by age ----------------------------------------------- */}
        <Section
          title="Where your value is aged"
          note="The same roster value spread across different age bands is a completely different asset. Value concentrated on the right is a window closing; concentrated on the left is a window that hasn't opened yet."
        >
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="panel">
              <div className="panel-head">
                <span className="eyebrow">By age band</span>
                <span className="axis-label">market value</span>
              </div>
              <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                {dynasty.valueByAge.map((band) => (
                  <div key={band.band} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-16 shrink-0 text-xs font-medium">{band.band}</span>
                    <CellBar
                      value={band.value}
                      max={maxAgeBand}
                      width={150}
                      color={
                        band.band === '30+'
                          ? 'var(--bad)'
                          : band.band === '27–29'
                            ? 'var(--warn)'
                            : 'var(--good)'
                      }
                      label={band.value.toLocaleString()}
                    />
                    <span className="ml-auto text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                      {band.count} player{band.count === 1 ? '' : 's'} ·{' '}
                      {formatPct(band.value / Math.max(dynasty.totalValue, 1))}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span className="eyebrow">By position</span>
                <span className="axis-label">market value</span>
              </div>
              <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                {dynasty.valueByPosition.map((entry) => (
                  <div key={entry.position} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-10 shrink-0">
                      <PositionChip position={entry.position} />
                    </span>
                    <CellBar
                      value={entry.value}
                      max={Math.max(...dynasty.valueByPosition.map((p) => p.value), 1)}
                      width={150}
                      color={positionColor(entry.position)}
                      label={entry.value.toLocaleString()}
                    />
                    <span className="ml-auto text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                      {entry.count} · {formatPct(entry.value / Math.max(dynasty.totalValue, 1))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Section>

        {/* ---- the window ------------------------------------------------- */}
        {dynasty.assets.some((asset) => asset.age !== null && asset.marketValue > 0) && (
          <Section
            title="Your window, player by player"
            note={
              <>
                Age against market value, with each position&apos;s decline age as the dividing
                line —{' '}
                {dynasty.declineAges
                  .map((d: { position: string; age: number; measured: boolean }) => `${d.position} ${d.age}${d.measured ? '' : '*'}`)
                  .join(', ')}
                . Those are the ages at which a position drops below 75% of its measured peak,
                fitted by comparing each player to himself a year later
                {dynasty.declineAges.some((d: { measured: boolean }) => !d.measured) &&
                  '; starred values are assumptions, kept only where the sample was too thin to fit'}
                .
                Dots to the right of centre are players whose value is most likely to fall from
                here. Dot size is what they project for this week.
              </>
            }
          >
            <div className="panel p-3">
              <Scatter
                xLabel="Years until position decline age →"
                yLabel="Market value →"
                quadrantLabels={['Aging, valuable', 'Young, valuable', 'Young, cheap', 'Aging, cheap']}
                xMedian={0}
                points={dynasty.assets
                  .filter((asset) => asset.windowYears !== null && asset.marketValue > 0)
                  .map((asset) => ({
                    key: asset.playerId,
                    x: asset.windowYears ?? 0,
                    y: asset.marketValue,
                    label: `${asset.name} (${asset.position}) — ${(asset.age ?? 0).toFixed(1)} yrs, ${asset.marketValue.toLocaleString()} value, ${asset.projected.toFixed(1)} projected`,
                    color: positionColor(asset.position),
                    radius: 3.5 + Math.min(asset.projected, 20) * 0.22,
                  }))}
              />
              <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                Left of the dashed line is past the decline age for the position.
              </p>
            </div>
          </Section>
        )}

        {/* ---- act on it -------------------------------------------------- */}
        <div className="grid gap-3 lg:grid-cols-3">
          {([
            ['Sell while there is a market', dynasty.sellHigh, 'var(--bad)', 'Past or nearly past the decline age for the position, and still carrying real market value. This is the value that disappears quietly.'],
            ['Hold or buy more', dynasty.buyLow, 'var(--good)', 'Cheap relative to what they already produce, with years left. The market is not paying for this production yet.'],
            ['Window risk', dynasty.windowRisk, 'var(--warn)', 'Genuine production sitting on players who will not be producing in two years. The reason a window closes.'],
          ] as const).map(([title, list, color, note]) =>
            list.length === 0 ? null : (
              <Section key={title} title={title} note={note}>
                <div className="panel divide-y" style={{ borderColor: 'var(--rule)' }}>
                  {list.map((asset) => (
                    <AssetRow key={asset.playerId} asset={asset} accent={color} />
                  ))}
                </div>
              </Section>
            ),
          )}
        </div>

        {/* ---- history ---------------------------------------------------- */}
        {withHistory.length > 0 && (
          <Section
            title="What your players have actually done"
            note={
              <>
                Three seasons of real games, kept as a distribution rather than an average — because
                the average is the part that lies. <strong>Floor</strong> and <strong>ceiling</strong>{' '}
                are the 25th and 75th percentiles of individual weeks; <strong>boom</strong> and{' '}
                <strong>bust</strong> count games over 20 and under 8. Two players at the same
                average are different assets if one of them loses you weeks.
                <br />
                <span style={{ color: 'var(--ink-faint)' }}>
                  Scored PPR, so a non-PPR league should read the shape rather than the level.
                </span>
              </>
            }
            aside={
              <Legend
                items={[
                  { label: 'floor → ceiling', color: 'var(--p-mid)' },
                  { label: 'boom rate', color: 'var(--good)' },
                  { label: 'bust rate', color: 'var(--bad)' },
                ]}
              />
            }
          >
            <div className="panel scroll-x">
              <table className="data-table" style={{ minWidth: '52rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '2rem' }} />
                    <th style={{ minWidth: '10rem' }}>Player</th>
                    <th className="text-right">G</th>
                    <th className="text-right">PPG</th>
                    <th style={{ width: '11rem' }}>Floor → ceiling</th>
                    <th className="text-right">Boom</th>
                    <th className="text-right">Bust</th>
                    <th>Read</th>
                    <th className="text-right">Trend</th>
                    <th style={{ width: '8rem' }} title="Points per game against two-high shells minus single-high">
                      Shell split
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {withHistory
                    .filter((asset) => asset.history !== null)
                    .sort((a, b) => (b.history?.ppg ?? 0) - (a.history?.ppg ?? 0))
                    .map((asset) => {
                      const history = asset.history!;
                      const maxCeiling = Math.max(
                        ...withHistory.map((entry) => entry.history?.ceiling ?? 0),
                        1,
                      );

                      return (
                        <tr key={asset.playerId}>
                          <td>
                            <PositionChip position={asset.position} />
                          </td>
                          <td className="max-w-[13rem] truncate">{history.name}</td>
                          <td className="tabular text-right faint" style={{ color: 'var(--ink-faint)' }}>
                            {history.games}
                          </td>
                          <td className="tabular text-right font-semibold">{history.ppg.toFixed(1)}</td>
                          <td>
                            <span className="inline-flex items-center gap-2">
                              <svg width={90} height={10} role="img" aria-label={`${history.floor} to ${history.ceiling}`}>
                                <rect x={0} y={4} width={90} height={2} rx={1} fill="var(--p-0)" />
                                <rect
                                  x={(history.floor / maxCeiling) * 90}
                                  y={2}
                                  width={Math.max(((history.ceiling - history.floor) / maxCeiling) * 90, 2)}
                                  height={6}
                                  rx={3}
                                  fill="var(--p-mid)"
                                />
                                <circle cx={(history.median / maxCeiling) * 90} cy={5} r={3} fill="var(--p-max)" />
                              </svg>
                              <span className="tabular text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                                {history.floor.toFixed(0)}–{history.ceiling.toFixed(0)}
                              </span>
                            </span>
                          </td>
                          <td className="tabular text-right" style={{ color: 'var(--good)' }}>
                            {formatPct(history.boomRate)}
                          </td>
                          <td className="tabular text-right" style={{ color: 'var(--bad)' }}>
                            {formatPct(history.bustRate)}
                          </td>
                          <td className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                            {reliabilityLabel(history)}
                          </td>
                          <td
                            className="tabular text-right text-[11px]"
                            style={{
                              color:
                                (history.trend ?? 0) > 2
                                  ? 'var(--good)'
                                  : (history.trend ?? 0) < -2
                                    ? 'var(--bad)'
                                    : 'var(--ink-faint)',
                            }}
                          >
                            {history.trend === null
                              ? '—'
                              : `${history.trend >= 0 ? '+' : ''}${history.trend.toFixed(1)} ${trendLabel(history) ?? ''}`}
                          </td>
                          <td>
                            {history.schemeSplit === null ? (
                              <span className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                                —
                              </span>
                            ) : (
                              <span
                                title={`${history.schemeSplit.twoHighPpg.toFixed(1)} PPG vs two-high (${history.schemeSplit.twoHighGames}g), ${history.schemeSplit.singleHighPpg.toFixed(1)} vs single-high (${history.schemeSplit.singleHighGames}g)`}
                              >
                                <DivergingBar
                                  value={history.schemeSplit.gap}
                                  max={8}
                                  width={72}
                                  label={`${history.schemeSplit.gap >= 0 ? '+' : ''}${history.schemeSplit.gap.toFixed(1)}`}
                                />
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                Shell split is points per game against defenses that keep two safeties deep, minus
                against single-high looks. Positive means he feasts on soft coverage; negative means
                he needs the deep shot to be available.
              </p>
            </div>
          </Section>
        )}

        {portfolio !== null && (
          <Section
            title="Your roster as a portfolio"
            note="Everything above treats players as independent. They are not: two men in the same offence share a quarterback, a play-caller and a game script, so their bad Sundays arrive together. That is the one thing a sum of values cannot show you, and it is why finance thinks in covariance rather than in totals."
          >
            <p className="mb-5 max-w-2xl text-base leading-relaxed">{portfolioRead(portfolio)}</p>

            <div className="mb-5 flex flex-wrap gap-x-10 gap-y-4">
              <div>
                <div className="eyebrow mb-1">Correlation penalty</div>
                <div
                  className="tabular text-2xl font-semibold"
                  style={{
                    color: portfolio.correlationPenalty > 1.06 ? 'var(--warn)' : 'var(--ink)',
                  }}
                >
                  {portfolio.correlationPenalty.toFixed(3)}×
                </div>
                <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  how much shared games widen your weekly range
                </div>
              </div>

              <div>
                <div className="eyebrow mb-1">Top-two share</div>
                <div className="tabular text-2xl font-semibold">
                  {(portfolio.topTwoShare * 100).toFixed(0)}%
                </div>
                <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  of roster value in two players
                </div>
              </div>

              {portfolio.byTeam[0] !== undefined && (
                <div>
                  <div className="eyebrow mb-1">Largest offence exposure</div>
                  <div className="tabular text-2xl font-semibold">
                    {(portfolio.byTeam[0].share * 100).toFixed(0)}%
                  </div>
                  <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                    {portfolio.byTeam[0].label} — {portfolio.byTeam[0].players.length} player
                    {portfolio.byTeam[0].players.length === 1 ? '' : 's'}
                  </div>
                </div>
              )}
            </div>

            <table className="w-full max-w-lg">
              <thead>
                <tr className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  <th className="pb-1 text-left font-normal">Offence</th>
                  <th className="pb-1 text-right font-normal">Share of value</th>
                  <th className="pb-1 text-left font-normal">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.byTeam.slice(0, 6).map((group) => (
                  <tr key={group.key} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                    <td className="py-1.5 text-sm">{group.label}</td>
                    <td className="tabular py-1.5 pr-3 text-right text-sm">
                      {(group.share * 100).toFixed(0)}%
                    </td>
                    <td className="py-1.5">
                      <CellBar value={group.share} max={1} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mt-3 max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              Correlation here is structural, not measured: players in the same game co-move by the
              product of their game loadings, and players in different games are treated as
              independent. A true covariance matrix needs a joint distribution this repository does
              not yet estimate, and the game-loading constants it rests on are themselves hand-set.
            </p>
          </Section>
        )}
      </main>
    </>
  );
}

const AssetRow = ({ asset, accent }: { asset: DynastyAsset; accent: string }) => (
  <div className="px-3 py-2">
    <div className="flex items-center gap-2">
      <PositionChip position={asset.position} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{asset.name}</span>
      <span className="tabular shrink-0 text-xs" style={{ color: accent }}>
        {asset.marketValue.toLocaleString()}
      </span>
    </div>
    <div className="tabular mt-0.5 flex flex-wrap gap-x-3 text-[10.5px]" style={{ color: 'var(--ink-faint)' }}>
      {asset.age !== null && <span>{asset.age.toFixed(1)} yrs</span>}
      {asset.windowYears !== null && (
        <span>
          {asset.windowYears >= 0
            ? `${asset.windowYears.toFixed(1)} yrs of window`
            : `${Math.abs(asset.windowYears).toFixed(1)} yrs past peak`}
        </span>
      )}
      <span>{asset.projected.toFixed(1)} proj</span>
      {asset.history !== null && <span>{asset.history.ppg.toFixed(1)} career PPG</span>}
    </div>
  </div>
);
