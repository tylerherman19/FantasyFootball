import { LeagueNav } from '@/components/LeagueNav';
import { RailBlock, RailLayout } from '@/components/design/DrillRail';
import { LeagueRail } from '@/components/design/LeagueRail';
import { TradeObjectiveBar } from '@/components/TradeObjectiveBar';
import { Section } from '@/components/Section';
import { TradeBuilder } from '@/components/TradeBuilder';
import {
  CellBar,
  DivergingBar,
  Legend,
  PositionChip,
  StackedBar,
  formatPct,
} from '@/components/charts/primitives';
import { requireSession } from '@/lib/session';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { serializeLeague } from '@/lib/serialize';
import { loadTrades } from '@/lib/trade-data';
import { loadPicks } from '@/lib/pick-data';
import { loadMarketValues } from '@/lib/values';

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

const VERDICT_COLOR: Record<string, string> = {
  thin: 'var(--bad)',
  balanced: 'var(--ink-muted)',
  surplus: 'var(--good)',
};

export default async function TradesPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { leagueId } = await params;
  const search = await searchParams;

  const one = (value: string | string[] | undefined): string | null =>
    typeof value === 'string' && value !== '' ? value : null;

  const objective = one(search.objective);
  const tradeQuery = {
    objective: objective === 'winNow' || objective === 'rebuild' ? objective : 'balanced',
    targetPlayerId: one(search.target),
    targetPosition: one(search.pos),
  } as const;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);

  if (view.myTeamId === null) {
    return <main className="mx-auto max-w-5xl px-6 py-12">Could not find your team in this league.</main>;
  }

  const myTeamId = view.myTeamId;
  const { snapshot } = view;

  const [trades, values, players, picks] = await Promise.all([
    loadTrades(view, myTeamId, tradeQuery),
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex, {
      teamCount: snapshot.league.teamCount,
      ppr: snapshot.league.scoring.rec,
    }),
    loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
    loadPicks(view),
  ]);

  const wire = serializeLeague(view, values, players, picks);

  /*
   * Everyone else's players, as things to go and get.
   *
   * Own players are excluded — "trade for a player you already have" is not a
   * request — and the list is ordered by market value so the names a manager is
   * most likely to want are reachable without scrolling.
   */
  const targetable = snapshot.rosters
    .filter((roster) => roster.teamId !== myTeamId)
    .flatMap((roster) =>
      roster.playerIds.map((id) => {
        const player = players[String(id)];
        return {
          id: String(id),
          name: player?.name ?? String(id),
          position: player?.position ?? '?',
          teamName: view.teamNames.get(roster.teamId) ?? roster.teamId,
          value: values.get(String(id))?.value ?? 0,
        };
      }),
    )
    .filter((player) => player.name !== player.id)
    .sort((a, b) => b.value - a.value)
    .slice(0, 300);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="trades"
        format={snapshot.league.format}
      />

      <RailLayout
        rail={
          <LeagueRail view={view}>
            <RailBlock title="What this page answers">
              A trade is a portfolio change. Both sides are re-simulated before and after, and fairness is answered separately from whether it helps you.
            </RailBlock>
          </LeagueRail>
        }
      >
        {/*
         * The finding, before the machinery.
         *
         * This page previously opened with a calculator and left the reader to
         * work out whether any of it mattered. Saying what the search actually
         * found — and saying plainly when it found nothing that clears the
         * simulation's resolution — is the difference between a tool that
         * advises and one that merely computes.
         */}
        {trades !== null && (
          <div
            className="mb-5 border-l-2 px-4 py-3 text-sm leading-relaxed"
            style={{ borderColor: 'var(--accent)', background: 'var(--surface-sunk)' }}
          >
            {trades.evaluations.length === 0 ? (
              <>
                <strong>No package cleared the fairness band.</strong>{' '}
                <span style={{ color: 'var(--ink-muted)' }}>
                  Every trade the search built was too lopsided for the other manager to accept.
                  Widening what you will send — or naming a target above — is the way through.
                </span>
              </>
            ) : (
              (() => {
                const best = trades.evaluations[0]!;
                const delta = best.odds.get(myTeamId)?.titleDelta ?? 0;
                const floor = 2 / Math.sqrt(1_200);
                const partner =
                  view.teamNames.get(best.sideB.teamId) ?? best.sideB.teamId;
                const gets = best.sideB.sends.map((asset) => asset.name).join(' and ');
                const sends = best.sideA.sends.map((asset) => asset.name).join(' and ');

                return (
                  <>
                    <strong>
                      {trades.evaluations.length}{' '}
                      {trades.evaluations.length === 1 ? 'package' : 'packages'} worth proposing.
                      The best is {sends} to {partner} for {gets}.
                    </strong>{' '}
                    <span style={{ color: 'var(--ink-muted)' }}>
                      {Math.abs(delta) > floor ? (
                        <>
                          It moves your title odds {delta > 0 ? 'up' : 'down'}{' '}
                          {Math.abs(delta * 100).toFixed(1)} points, which is larger than this
                          simulation&apos;s ±{(floor * 100).toFixed(1)}pp resolution — a real
                          difference rather than noise.
                        </>
                      ) : (
                        <>
                          Its effect on your title odds is inside the ±{(floor * 100).toFixed(1)}pp
                          this simulation can resolve, so treat the ordering below as a shortlist
                          to judge rather than a ranking to trust to the decimal.
                        </>
                      )}
                    </span>
                  </>
                )
              })()
            )}
          </div>
        )}

        <TradeObjectiveBar players={targetable} />

        <Section
          title="Trade calculator"
            source="2,000 season simulations · model v1-usage+positional"
          note={
            <>
              Pick players from either side. Each change re-simulates the rest of the season in your
              browser: market value for whether they&apos;d accept, championship odds for whether you
              should want it.
            </>
          }
        >
          <TradeBuilder league={wire} myTeamId={myTeamId} />
        </Section>

        {trades !== null && trades.partners.length > 0 && (
          <Section
            title="Who to call"
            note={
              <>
                Every roster in the league analysed the same way as yours. A trade happens when the
                piece you are offering is worth more to them than what they give up — so fit is
                scored in both directions, and the bar is how well the two rosters complement each
                other.
              </>
            }
          >
            <div className="space-y-2">
              {trades.partners.map((partner) => (
                <article key={partner.partnerTeamId} className="panel p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {view.teamNames.get(partner.partnerTeamId) ?? partner.partnerTeamId}
                    </span>
                    <CellBar
                      value={partner.mutualFit}
                      max={Math.max(...trades.partners.map((other) => other.mutualFit), 1)}
                      width={110}
                      color="var(--p-high)"
                      label={`fit ${partner.mutualFit.toFixed(1)}`}
                    />
                  </div>
                  <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {partner.reason}
                  </p>

                  {/*
                    * Both halves of the trade.
                    *
                    * This listed only what to send, which is not a proposal —
                    * "offer them Justice Hill" says nothing about what Justice
                    * Hill is meant to bring home. Send and ask side by side, each
                    * measured against the hole it fills on the other roster.
                    */}
                  {/*
                    * `asks` is read defensively because the cached TradeView
                    * outlives a deploy: a shape added in one release meets
                    * objects serialised by the previous one, and the field is
                    * simply absent for the life of that cache entry. TypeScript
                    * cannot see that — the type is right, the runtime value is
                    * older than the type.
                    */}
                  {(partner.offers.length > 0 || (partner.asks ?? []).length > 0) && (
                    <div
                      className="mt-3 grid gap-x-6 gap-y-3 border-t pt-2 sm:grid-cols-2"
                      style={{ borderColor: 'var(--rule)' }}
                    >
                      {([
                        {
                          key: 'send',
                          label: 'You send',
                          rows: partner.offers,
                          colour: 'var(--bad)',
                          suffix: 'to them',
                          hint: 'Spare in your lineup, and fills a position they are thin at.',
                        },
                        {
                          key: 'get',
                          label: 'You ask for',
                          rows: partner.asks ?? [],
                          colour: 'var(--good)',
                          suffix: 'to you',
                          hint: 'Spare in their lineup, and fills a position you are thin at.',
                        },
                      ] as const).map((side) => (
                        <div key={side.key}>
                          <div
                            className="mb-1 text-[10px] font-semibold uppercase tracking-widest"
                            style={{ color: 'var(--ink-faint)' }}
                            title={side.hint}
                          >
                            {side.label}
                          </div>
                          {side.rows.length === 0 ? (
                            <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                              Nothing of theirs is both spare and useful to you — which is why this
                              partner is lower down the list.
                            </p>
                          ) : (
                            <ul className="text-sm">
                              {side.rows.map((row) => (
                                <li
                                  key={row.playerId}
                                  className="flex items-center gap-2 py-0.5"
                                  title={`${row.name} (${row.position}) — projects ${row.projected.toFixed(1)} a week, worth about ${row.helpsThemBy.toFixed(1)} ${side.suffix}`}
                                >
                                  <PositionChip position={row.position} />
                                  <span className="min-w-0 flex-1 truncate text-xs">{row.name}</span>
                                  <CellBar
                                    value={row.helpsThemBy}
                                    max={Math.max(
                                      ...trades.partners.flatMap((other) =>
                                        [...other.offers, ...(other.asks ?? [])].map(
                                          (e) => e.helpsThemBy,
                                        ),
                                      ),
                                      1,
                                    )}
                                    width={64}
                                    color={side.colour}
                                    label={`+${row.helpsThemBy.toFixed(1)} ${side.suffix}`}
                                  />
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                </article>
              ))}
            </div>
          </Section>
        )}

        {trades !== null && trades.depth.length > 0 && (
          <Section
            title="What you can actually spare"
            source="model v1-usage+positional · projections rebuilt weekly"
            note={
              <>
                Measured by consequence, not headcount: what your best lineup loses without each
                player. A backup behind an elite starter reads as spare; a mediocre starter at a thin
                spot does not.
              </>
            }
          >

            <div className="panel mb-5 divide-y" style={{ borderColor: 'var(--rule)' }}>
              {[...trades.depth]
                .sort((a, b) => b.totalMarginal - a.totalMarginal)
                .map((assessment) => (
                  <div key={assessment.position} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-9 shrink-0">
                      <PositionChip position={assessment.position} />
                    </span>
                    <span
                      className="w-16 shrink-0 text-[11px] font-medium"
                      style={{ color: VERDICT_COLOR[assessment.verdict] }}
                    >
                      {assessment.verdict}
                    </span>
                    <span className="min-w-0 flex-1">
                      <StackedBar
                        max={Math.max(...trades.depth.map((entry) => entry.totalMarginal), 1)}
                        width={300}
                        height={13}
                        showLabels={false}
                        segments={[
                          { key: 'exposed', value: assessment.exposureToTopLoss, color: 'var(--bad)' },
                          {
                            key: 'rest',
                            value: Math.max(0, assessment.totalMarginal - assessment.exposureToTopLoss),
                            color: 'var(--p-high)',
                          },
                        ]}
                      />
                    </span>
                    <span className="tabular w-12 shrink-0 text-right text-xs">
                      {assessment.totalMarginal.toFixed(1)}
                    </span>
                    <span className="tabular w-12 shrink-0 text-right text-xs" style={{ color: 'var(--bad)' }}>
                      −{assessment.exposureToTopLoss.toFixed(1)}
                    </span>
                  </div>
                ))}
            </div>

            <h3 className="eyebrow mb-2">Most movable players</h3>
            <div className="panel scroll-x">
              <table className="data-table" style={{ minWidth: '34rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '2rem' }} />
                    <th style={{ minWidth: '10rem' }}>Player</th>
                    <th style={{ width: '7rem' }}>Projects</th>
                    <th style={{ width: '7rem' }}>Lineup loses</th>
                    <th style={{ width: '7rem' }}>Market value</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.marginal.slice(0, 12).map((entry) => (
                    <tr key={entry.playerId}>
                      <td>
                        <PositionChip position={entry.position} />
                      </td>
                      <td className="max-w-[13rem] truncate font-medium">{entry.name}</td>
                      <td>
                        <CellBar
                          value={entry.projected}
                          max={Math.max(...trades.marginal.map((other) => other.projected), 1)}
                          width={50}
                          color="var(--p-low)"
                          label={entry.projected.toFixed(1)}
                        />
                      </td>
                      <td>
                        <CellBar
                          value={entry.marginal}
                          max={Math.max(...trades.marginal.map((other) => other.marginal), 1)}
                          width={50}
                          color={entry.marginal < 1 ? 'var(--good)' : 'var(--p-high)'}
                          label={entry.marginal.toFixed(1)}
                        />
                      </td>
                      <td>
                        <CellBar
                          value={entry.value}
                          max={Math.max(...trades.marginal.map((other) => other.value), 1)}
                          width={50}
                          color="var(--pos-qb)"
                          label={entry.value > 0 ? entry.value.toLocaleString() : '—'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              A player whose market bar is long and whose &ldquo;lineup loses&rdquo; bar is short is
              the ideal chip: you are selling something the market prices and your roster does not
              use.
            </p>
          </Section>
        )}

        {trades !== null && trades.evaluations.length > 0 && (
          <Section
            title="Proposals worth making"
            note="Scanned across the league, filtered to packages a real manager might accept, then simulated. The bars are the change in each side's title probability — a proposal where both bars point right is the rare genuinely mutual trade."
            aside={
              <Legend
                items={[
                  { label: 'helps', color: 'var(--good)' },
                  { label: 'hurts', color: 'var(--bad)' },
                ]}
              />
            }
          >
            <div className="space-y-3">
              {trades.evaluations.map((evaluation, index) => {
                const mine = evaluation.odds.get(myTeamId);
                const theirs = evaluation.odds.get(evaluation.sideB.teamId);
                const partner = view.teamNames.get(evaluation.sideB.teamId) ?? evaluation.sideB.teamId;

                // A common scale across every proposal, so the bars compare.
                const widest = Math.max(
                  ...trades.evaluations.flatMap((other) => [
                    Math.abs(other.odds.get(myTeamId)?.titleDelta ?? 0),
                    Math.abs(other.odds.get(other.sideB.teamId)?.titleDelta ?? 0),
                  ]),
                  0.005,
                );

                return (
                  <article key={index} className="panel p-4">
                    <div className="eyebrow mb-3">with {partner}</div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <div className="axis-label mb-1 uppercase tracking-wider">You send</div>
                        {evaluation.sideA.sends.map((asset) => (
                          <div key={String(asset.playerId)} className="flex items-center gap-1.5 py-0.5">
                            <PositionChip position={asset.position} />
                            <span className="truncate text-sm font-medium">{asset.name}</span>
                            <span className="tabular ml-auto text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                              {asset.value.toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="axis-label mb-1 uppercase tracking-wider">You get</div>
                        {evaluation.sideB.sends.map((asset) => (
                          <div key={String(asset.playerId)} className="flex items-center gap-1.5 py-0.5">
                            <PositionChip position={asset.position} />
                            <span className="truncate text-sm font-medium">{asset.name}</span>
                            <span className="tabular ml-auto text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                              {asset.value.toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div
                      className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-3"
                      style={{ borderColor: 'var(--rule)' }}
                    >
                      <div>
                        <div className="axis-label">Your title odds</div>
                        <DivergingBar
                          value={mine?.titleDelta ?? 0}
                          max={widest}
                          width={140}
                          label={pct(mine?.titleDelta ?? 0)}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Their title odds</div>
                        <DivergingBar
                          value={theirs?.titleDelta ?? 0}
                          max={widest}
                          width={140}
                          label={pct(theirs?.titleDelta ?? 0)}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Market gap</div>
                        <CellBar
                          value={evaluation.fairness}
                          max={0.3}
                          width={90}
                          color={evaluation.fairness > 0.2 ? 'var(--warn)' : 'var(--p-mid)'}
                          label={formatPct(evaluation.fairness)}
                        />
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-3">
                      <div>
                        <div className="axis-label">Partner fit</div>
                        <CellBar
                          value={evaluation.acceptanceScore}
                          max={1}
                          width={90}
                          color="var(--p-mid)"
                          label={`${Math.round(evaluation.acceptanceScore * 100)}%`}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Your lineup fit</div>
                        <CellBar
                          value={evaluation.fitScore}
                          max={1}
                          width={90}
                          color="var(--good)"
                          label={`${Math.round(evaluation.fitScore * 100)}%`}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Recommendation</div>
                        <CellBar
                          value={evaluation.recommendationScore}
                          max={100}
                          width={90}
                          color="var(--accent)"
                          label={`${Math.round(evaluation.recommendationScore)}/100`}
                        />
                      </div>
                    </div>

                    <p className="mt-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {evaluation.verdict} {evaluation.rationale.join(' · ')}
                    </p>
                  </article>
                );
              })}
            </div>
          </Section>
        )}

      </RailLayout>
    </>
  );
}
