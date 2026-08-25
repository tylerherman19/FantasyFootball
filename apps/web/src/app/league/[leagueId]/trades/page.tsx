import { LeagueNav } from '@/components/LeagueNav';
import { RailBlock, RailLayout } from '@/components/design/DrillRail';
import { LeagueRail } from '@/components/design/LeagueRail';
import { TradeObjectiveBar } from '@/components/TradeObjectiveBar';
import { Section } from '@/components/Section';
import {
  CellBar,
  DivergingBar,
  Legend,
  PositionChip,
  formatPct,
} from '@/components/charts/primitives';
import { requireSession } from '@/lib/session';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { loadTrades } from '@/lib/trade-data';

const pct = (value: number) => (value >= 0 ? '+' : '') + (value * 100).toFixed(1) + '%';

const money = (value: number) => (value > 0 ? value.toLocaleString() : '—');

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

  const objectiveParam = one(search.objective);
  const targetPlayerId = one(search.target);
  const targetPosition = one(search.pos);
  const objective =
    objectiveParam === 'winNow' || objectiveParam === 'rebuild' ? objectiveParam : 'balanced';

  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);

  if (view.myTeamId === null) {
    return <main className="mx-auto max-w-5xl px-6 py-12">Could not find your team in this league.</main>;
  }

  const myTeamId = view.myTeamId;
  const { snapshot } = view;

  const [trades, players] = await Promise.all([
    loadTrades(view, myTeamId, {
      objective,
      targetPlayerId,
      targetPosition,
    }),
    loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
  ]);

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
        };
      }),
    )
    .filter((player) => player.name !== player.id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 300);

  const selectedPlayer = targetPlayerId === null
    ? undefined
    : targetable.find((player) => player.id === targetPlayerId);

  const requestLabel = selectedPlayer !== undefined
    ? selectedPlayer.name
    : targetPosition !== null
      ? targetPosition + 's'
      : 'a player';

  const proposalScale =
    trades === null
      ? 0.005
      : Math.max(
          ...trades.evaluations.flatMap((evaluation) => [
            Math.abs(evaluation.odds.get(myTeamId)?.titleDelta ?? 0),
            Math.abs(evaluation.odds.get(evaluation.sideB.teamId)?.titleDelta ?? 0),
          ]),
          0.005,
        );

  const isRequestedAsset = (playerId: string, position: string): boolean => {
    if (targetPlayerId !== null) return playerId === targetPlayerId;
    if (targetPosition !== null) return position === targetPosition;
    return false;
  };

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
            <RailBlock title="How to use the finder">
              Start with what you want to acquire. The engine searches the league for that player
              or position, then shows the package you should offer for it. The offer side is
              replacement-aware: it avoids treating a backup quarterback as a weekly starter.
            </RailBlock>
          </LeagueRail>
        }
      >
        <header className="mb-8">
          <div className="eyebrow mb-2">Trade finder</div>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
            Get {requestLabel}. See exactly what to offer.
          </h1>
          <p className="deck mt-3 max-w-2xl">
            The model starts from your desired acquisition, not from a list of players you could
            theoretically move. Each recommendation pairs a target with a concrete offer, then
            checks lineup impact, partner fit, market balance, and evidence quality.
          </p>
        </header>

        <TradeObjectiveBar players={targetable} />

        <div
          className="mb-8 grid gap-px border sm:grid-cols-3"
          style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}
        >
          <div className="bg-[var(--surface)] p-4">
            <div className="eyebrow mb-1">Request</div>
            <div className="text-lg font-semibold">{requestLabel}</div>
            <div className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
              {targetPlayerId !== null || targetPosition !== null
                ? 'The acquisition side is locked to your selection.'
                : 'Choose a position or player above to narrow the search.'}
            </div>
          </div>
          <div className="bg-[var(--surface)] p-4">
            <div className="eyebrow mb-1">Search result</div>
            <div className="text-lg font-semibold">
              {trades === null ? 'Unavailable' : trades.evaluations.length + ' proposals'}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Ranked by the engine for your selected objective.
            </div>
          </div>
          <div className="bg-[var(--surface)] p-4">
            <div className="eyebrow mb-1">Roster context</div>
            <div className="text-lg font-semibold">
              {trades === null || trades.needs.length === 0
                ? 'Balanced'
                : 'Needs ' + trades.needs.join(' · ')}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Depth changes the offer; it does not override your target.
            </div>
          </div>
        </div>

        <Section
          title="What you should offer"
          source="1,200 season simulations · market values · replacement-aware lineup analysis · v1-usage+offense+positional"
          note={
            <>
              These are target-first proposals. The right column is what you asked for; the left
              column is the package the model thinks you should offer. A proposal can be close in
              market value and still be poor for your roster, so the ranking also prices title odds,
              lineup contribution, partner acceptance, and evidence confidence.
            </>
          }
          aside={
            <Legend
              items={[
                { label: 'you offer', color: 'var(--bad)' },
                { label: 'you get', color: 'var(--good)' },
              ]}
            />
          }
        >
          {trades === null ? (
            <div className="panel p-5 text-sm" style={{ color: 'var(--ink-muted)' }}>
              The trade engine could not load this league&apos;s current projection set.
            </div>
          ) : trades.evaluations.length === 0 ? (
            <div className="panel p-5">
              <h3 className="text-lg font-semibold">
                No {requestLabel} package cleared the search.
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                There is no market-balanced package for this target in the current data. Try a
                specific player, switch from win now to balanced or rebuild, or choose another
                position. The page will never fill this section with unrelated players just to make
                the list look busy.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {trades.evaluations.map((evaluation, index) => {
                const mine = evaluation.odds.get(myTeamId);
                const theirs = evaluation.odds.get(evaluation.sideB.teamId);
                const partner =
                  view.teamNames.get(evaluation.sideB.teamId) ?? evaluation.sideB.teamId;

                return (
                  <article key={index} className="panel overflow-hidden">
                    <div
                      className="flex flex-wrap items-start justify-between gap-4 border-b p-4"
                      style={{ borderColor: 'var(--rule)' }}
                    >
                      <div>
                        <div className="eyebrow mb-1">Proposal {index + 1}</div>
                        <h3 className="text-xl font-semibold">Offer to {partner}</h3>
                        <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                          This partner owns the {requestLabel} you selected.
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="eyebrow mb-1">Recommendation</div>
                        <div className="figure text-2xl font-semibold" style={{ color: 'var(--accent)' }}>
                          {Math.round(evaluation.recommendationScore)}/100
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-0 md:grid-cols-2">
                      <div
                        className="border-b-2 p-4 md:border-b-0 md:border-r"
                        style={{ borderColor: 'var(--bad)', background: 'color-mix(in srgb, var(--bad) 5%, var(--surface))' }}
                      >
                        <div className="eyebrow mb-1">What you should offer</div>
                        <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
                          Players the model can remove with the least damage to your optimal lineup.
                        </p>
                        <div className="space-y-2">
                          {evaluation.sideA.sends.map((asset) => (
                            <div
                              key={String(asset.playerId)}
                              className="flex items-center gap-2 border-t pt-2"
                              style={{ borderColor: 'var(--rule)' }}
                            >
                              <PositionChip position={asset.position} />
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {asset.name}
                              </span>
                              <span className="tabular text-xs" style={{ color: 'var(--ink-muted)' }}>
                                {asset.quantiles === undefined
                                  ? money(asset.value)
                                  : asset.quantiles.p25.toFixed(1) + ' / ' + asset.quantiles.p50.toFixed(1) + ' / ' + asset.quantiles.p75.toFixed(1)}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 border-t pt-3 text-xs" style={{ borderColor: 'var(--rule)' }}>
                          <span style={{ color: 'var(--ink-muted)' }}>Offer value </span>
                          <strong>
                            {evaluation.sideA.sends.reduce((sum, asset) => sum + asset.value, 0).toLocaleString()}
                          </strong>
                        </div>
                      </div>

                      <div
                        className="p-4"
                        style={{ background: 'color-mix(in srgb, var(--good) 5%, var(--surface))' }}
                      >
                        <div className="eyebrow mb-1">What you get</div>
                        <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
                          The requested target is highlighted. No unrelated player is substituted.
                        </p>
                        <div className="space-y-2">
                          {evaluation.sideB.sends.map((asset) => {
                            const requested = isRequestedAsset(String(asset.playerId), asset.position);
                            return (
                              <div
                                key={String(asset.playerId)}
                                className="flex items-center gap-2 border-t pt-2"
                                style={{ borderColor: requested ? 'var(--good)' : 'var(--rule)' }}
                              >
                                <PositionChip position={asset.position} />
                                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                  {asset.name}
                                </span>
                                {requested && (
                                  <span
                                    className="shrink-0 text-[10px] font-semibold uppercase tracking-widest"
                                    style={{ color: 'var(--good)' }}
                                  >
                                    target
                                  </span>
                                )}
                                <span className="tabular text-xs" style={{ color: 'var(--ink-muted)' }}>
                                  {asset.quantiles === undefined
                                    ? money(asset.value)
                                    : asset.quantiles.p25.toFixed(1) + ' / ' + asset.quantiles.p50.toFixed(1) + ' / ' + asset.quantiles.p75.toFixed(1)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-3 border-t pt-3 text-xs" style={{ borderColor: 'var(--rule)' }}>
                          <span style={{ color: 'var(--ink-muted)' }}>Return value </span>
                          <strong>
                            {evaluation.sideB.sends.reduce((sum, asset) => sum + asset.value, 0).toLocaleString()}
                          </strong>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-4 border-t p-4 sm:grid-cols-4" style={{ borderColor: 'var(--rule)' }}>
                      <div>
                        <div className="axis-label">Your title odds</div>
                        <DivergingBar
                          value={mine?.titleDelta ?? 0}
                          max={proposalScale}
                          width={150}
                          label={pct(mine?.titleDelta ?? 0)}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Partner acceptance</div>
                        <CellBar
                          value={evaluation.acceptanceScore}
                          max={1}
                          width={110}
                          color="var(--p-mid)"
                          label={Math.round(evaluation.acceptanceScore * 100) + '%'}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Market gap</div>
                        <CellBar
                          value={evaluation.fairness}
                          max={0.3}
                          width={110}
                          color={evaluation.fairness > 0.2 ? 'var(--warn)' : 'var(--p-mid)'}
                          label={formatPct(evaluation.fairness)}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Evidence</div>
                        <CellBar
                          value={evaluation.evidenceScore}
                          max={1}
                          width={110}
                          color="var(--p-low)"
                          label={Math.round(evaluation.evidenceScore * 100) + '%'}
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 border-t p-4 sm:grid-cols-3" style={{ borderColor: 'var(--rule)' }}>
                      <div>
                        <div className="axis-label">Partner title odds</div>
                        <DivergingBar
                          value={theirs?.titleDelta ?? 0}
                          max={proposalScale}
                          width={150}
                          label={pct(theirs?.titleDelta ?? 0)}
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <div className="axis-label mb-1">Why this package</div>
                        <ul className="space-y-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                          {evaluation.rationale.map((reason) => (
                            <li key={reason}>• {reason}</li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="border-t px-4 py-3 text-sm font-medium" style={{ borderColor: 'var(--rule)' }}>
                      {evaluation.verdict}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </Section>

        {trades !== null && (
          <details className="mb-10 border-t pt-4" style={{ borderColor: 'var(--rule)' }}>
            <summary className="cursor-pointer text-sm font-semibold">
              How the finder decides what to show
            </summary>
            <div className="mt-3 grid gap-4 text-xs leading-relaxed sm:grid-cols-3" style={{ color: 'var(--ink-muted)' }}>
              <div>
                <strong className="text-[var(--ink)]">1. Start with your target.</strong>
                <p className="mt-1">
                  A position or player filter applies to the acquisition side. If you choose RB,
                  every package shown here acquires an RB.
                </p>
              </div>
              <div>
                <strong className="text-[var(--ink)]">2. Find a credible offer.</strong>
                <p className="mt-1">
                  The engine tests what you can send against the partner&apos;s roster and market
                  value. It does not show a generic list of movable players as the answer.
                </p>
              </div>
              <div>
                <strong className="text-[var(--ink)]">3. Rank the package.</strong>
                <p className="mt-1">
                  Title odds, replacement-aware lineup value, partner fit, scheme context, and
                  evidence confidence determine the order.
                </p>
              </div>
            </div>
          </details>
        )}
      </RailLayout>
    </>
  );
}
