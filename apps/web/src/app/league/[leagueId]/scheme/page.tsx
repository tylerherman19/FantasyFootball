import { LeagueNav } from '@/components/LeagueNav';
import { RailLayout } from '@/components/design/DrillRail';
import { LeagueRail } from '@/components/design/LeagueRail';
import { Section, StatRow, StatTile } from '@/components/Section';
import {
  CellBar,
  DivergingBar,
  Legend,
  PositionChip,
  Scatter,
  StackedBar,
  formatPct,
  positionColor,
} from '@/components/charts/primitives';
import { loadDefenses, matchupFor, opponentFrom, shellLabel, type DefenseProfile } from '@/lib/defense';
import { callVerdict, flippableCount, loadSchemeFinding } from '@/lib/scheme-impact';
import { leagueMeta, lineupShape, loadLeague } from '@/lib/league-data';
import { requireSession } from '@/lib/session';
import { orderRoster } from '@/lib/lineup-order';
import { loadAvailability } from '@/lib/availability';
import { isPlayingIn, loadArtifact, scoreFor } from '@/lib/projections';
import { buildUsage } from '@/lib/usage';

/**
 * Defensive scheme, and what it does to your players.
 *
 * The one structural fact this page is built on: a defense cannot take away the
 * deep ball and the run at the same time. Two safeties deep is one fewer
 * defender in the box, and every consequence follows from that trade — which is
 * why the same defense that ruins your outside receiver is the one your running
 * back wants, and the tight end quietly eats either way.
 *
 * Every number is measured from play-by-play and opponent-adjusted, so a
 * defense that drew a soft schedule does not get credit for it.
 */

const scoreColor = (score: number): string =>
  score > 0.25 ? 'var(--good)' : score < -0.25 ? 'var(--bad)' : 'var(--ink-muted)';

export default async function SchemePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  const { snapshot } = view;

  const [defenses, { players }, finding, artifact, availability] = await Promise.all([
    loadDefenses(),
    buildUsage(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
    loadSchemeFinding(),
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadAvailability(),
  ]);

  const nav = (
    <LeagueNav
      leagueId={leagueId}
      leagueName={snapshot.league.name}
      meta={leagueMeta(snapshot)}
      lineupShape={lineupShape(snapshot)}
      active="scheme"
      format={snapshot.league.format}
      stamps={
        defenses === null
          ? undefined
          : [
              { label: 'Defenses', value: String(defenses.teamCount) },
              { label: 'Seasons', value: defenses.seasons.join(' + ') },
              { label: 'Model', value: defenses.modelVersion },
            ]
      }
    />
  );

  if (defenses === null) {
    return (
      <>
        {nav}
        <main className="mx-auto max-w-6xl px-5 pb-20 lg:pl-[4.75rem]">
        </main>
      </>
    );
  }

  const all = Object.values(defenses.teams);
  const byShell = [...all].sort((a, b) => b.shellIndex - a.shellIndex);

  /*
   * Your roster, in starting-lineup order.
   *
   * Sorted by projected points until now, which is a ranking rather than a
   * roster — the flexes scattered among the receivers and nothing on the page
   * matched the order the manager reads his own team in. `orderRoster` fills
   * the league's own slots optimally and puts the bench underneath, so a
   * superflex league shows a superflex and an IDP league shows its own shape.
   *
   * It also gives the margin: what each starter is being started *over*, at his
   * actual slot and under its flex rules. That is the same number the lineup
   * page quotes, from the same function, which is the point — two pages
   * disagreeing about how close a call is would discredit both.
   */
  const rules = snapshot.league.scoring.raw;
  const rosterIds = snapshot.rosters.find((roster) => roster.teamId === view.myTeamId)?.playerIds ?? [];

  const orderInputs = rosterIds.flatMap((raw) => {
    const id = String(raw);
    const projection = artifact?.players[id];
    if (projection === undefined || !isPlayingIn(projection, snapshot.asOfWeek)) return [];

    return [
      {
        playerId: id,
        position: projection.position,
        projected: scoreFor(projection, rules, availability[id]?.injuryStatus ?? null, snapshot.asOfWeek),
        sd: projection.sd,
      },
    ];
  });

  const order = orderRoster(orderInputs, snapshot.league.rosterSlots);
  const usageOf = new Map(players.map((player) => [player.playerId, player]));
  const nameOf = (id: string): string =>
    artifact?.players[id]?.name ?? usageOf.get(id)?.name ?? id;

  const decisions = order.rows.flatMap((row) => {
    const usage = usageOf.get(row.playerId);
    const team = artifact?.players[row.playerId]?.team ?? usage?.team ?? '';
    const gameId = artifact?.players[row.playerId]?.gameId ?? usage?.gameId ?? '';

    const opponent = opponentFrom(gameId, team);
    const defense = opponent === null ? undefined : defenses.teams[opponent];
    if (defense === undefined || opponent === null) return [];

    const alternative = order.alternativeFor(row.playerId);

    return [
      {
        row,
        name: nameOf(row.playerId),
        team,
        opponent,
        defense,
        opportunities: usage?.opportunities ?? 0,
        effect: matchupFor(row.position, defense, all),
        verdict: callVerdict(
          alternative?.margin ?? 0,
          row.sd,
          alternative === null ? null : nameOf(alternative.playerId),
          finding,
        ),
      },
    ];
  });

  const starters = decisions.filter((entry) => entry.row.starting);
  const closeCalls = flippableCount(starters.map((d) => d.verdict));

  const extreme = (of: (profile: DefenseProfile) => number, top: boolean) =>
    [...all].sort((a, b) => (top ? of(b) - of(a) : of(a) - of(b)))[0];

  const softest = extreme((d) => d.shellIndex, true);
  const hardest = extreme((d) => d.shellIndex, false);
  const mostPressure = extreme((d) => d.pressureIndex, true);

  return (
    <>
      {nav}

        <RailLayout
        rail={<LeagueRail view={view} />}
      >
        {/* ---- your week, leading ----------------------------------------- */}
        {decisions.length > 0 && (
          <Section
            title={
              closeCalls === 0
                ? `Scheme changes none of your ${starters.length} lineup calls this week.`
                : `Scheme could change ${closeCalls} of your ${starters.length} lineup calls.`
            }
            source="nflverse play-by-play · defensive matchup context"
            note="Offensive scheme is built into player opportunity; this page isolates the defensive matchup read."
          >
            <div className="scheme-thesis">
              <div>
                <span className="scheme-thesis-number">{closeCalls}</span>
                <span className="scheme-thesis-denominator">/{starters.length}</span>
              </div>
              <p>
                <strong>starts within scheme&rsquo;s reach</strong>
                <span>
                  Widest measured effect: ±{Math.max(0, ...decisions.map((d) => d.verdict.bound)).toFixed(2)} points.
                  Toughest read: {[...starters].sort((a, b) => a.effect.score - b.effect.score)[0]?.name ?? '—'}.
                </span>
              </p>
              <a href={`/league/${leagueId}/lineup`} className="scheme-lineup-link">
                Open lineup analysis →
              </a>
            </div>

            <div className="scheme-roster">
              <div className="scheme-roster-head" aria-hidden="true">
                <span>Slot / player</span>
                <span>Decision</span>
                <span>Matchup read</span>
              </div>
              {decisions.map((entry, index) => {
                const { row, name, team, opponent, defense, effect, verdict } = entry;
                /*
                 * One rule between the last starter and the first bench player.
                 * Slot order only means anything if the line it is building
                 * toward is visible.
                 */
                const firstBench = row.starting === false && decisions[index - 1]?.row.starting === true;

                return (
                  <div key={row.playerId}>
                    {firstBench && (
                      <div className="scheme-bench-rule">
                        <span>Bench</span>
                        <span>Context only—these players are not being started over anyone.</span>
                      </div>
                    )}

                    <article
                      className="scheme-player-row"
                      data-flippable={verdict.couldFlip}
                    >
                      <div className="scheme-player-identity">
                        <span
                          className="scheme-slot"
                          style={{ color: row.starting ? 'var(--accent)' : 'var(--ink-faint)' }}
                          title={row.starting ? `Starting at ${row.slotLabel}` : 'On your bench'}
                        >
                          {row.slotLabel}
                        </span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <PositionChip position={row.position} />
                            <span className="text-sm font-semibold">{name}</span>
                          </div>
                          <span className="scheme-opponent">{team} vs {opponent}</span>
                        </div>
                      </div>

                      <div className="scheme-decision">
                        {row.starting ? (
                          <>
                            <strong>{verdict.couldFlip ? 'Review this call' : 'Hold the start'}</strong>
                            <span>
                              {verdict.alternative === null
                                ? 'No eligible bench alternative.'
                                : `${verdict.margin < 0.1 ? verdict.margin.toFixed(2) : verdict.margin.toFixed(1)} pts over ${verdict.alternative}; scheme ceiling ±${verdict.bound.toFixed(2)}.`}
                            </span>
                          </>
                        ) : (
                          <>
                            <strong>Bench context</strong>
                            <span>{row.projected.toFixed(1)} projected points.</span>
                          </>
                        )}
                      </div>

                      <div className="scheme-matchup">
                        <span
                          className="scheme-matchup-label"
                          style={{ color: scoreColor(effect.score) }}
                          title={`Scheme read: ${effect.headline}. Displayed only — never applied to the projection.`}
                        >
                          {effect.headline}
                        </span>
                        <DivergingBar value={effect.score} max={1} width={90} height={9} />
                      </div>

                      <p className="scheme-evidence">
                        {effect.detail}
                      </p>

                      <div className="scheme-row-meta">
                        <span>
                          {opponent} shell{' '}
                          <strong>{shellLabel(defense.shellIndex)}</strong>
                        </span>
                        <span>
                          projection <strong>{row.projected.toFixed(1)}</strong>
                        </span>
                        <span>
                          opportunity <strong>{entry.opportunities.toFixed(1)}</strong>
                        </span>
                      </div>
                    </article>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* ---- and what that read is worth -------------------------------- */}
        {finding !== null && (
          <Section
            title="What the read above is actually worth"
            source={`model/backtest/run_scheme_variance.py · ${finding.n.toLocaleString()} player-weeks, ${finding.seasons.join('–')}`}
            note={
              <>
                Three times now this model has tried to turn the matchup into a number, and three
                times the measurement has said no. The first two scaled the projection by opponent
                strength — once on points, once on opportunity alone — and both made the forecast
                worse in proportion to how hard they were applied.
                <br />
                <br />
                The third is new, and it tested the claim this page used to make: that a soft shell
                leaves a player&rsquo;s average alone while <em>clipping a receiver&rsquo;s ceiling
                and opening a back&rsquo;s floor</em>. Mean error cannot see a change of that
                shape, so it was never tested. It is now. If it were real, the two ratios below
                would sit on opposite sides of 1.00.
              </>
            }
          >
            <StatRow columns={4}>
              {(['WR', 'RB', 'TE', 'QB'] as const).map((position) => {
                const ratio = finding.ratios[position];
                return (
                  <StatTile
                    key={position}
                    label={`${position} spread ratio`}
                    value={ratio === undefined ? '—' : ratio.toFixed(3)}
                    sub="soft shell ÷ loaded box · 1.000 means scheme did nothing"
                  />
                );
              })}
            </StatRow>

            <p className="mt-3 max-w-2xl text-sm leading-relaxed">
              Receivers came out at{' '}
              <strong>{finding.ratios['WR']?.toFixed(3) ?? '—'}</strong> and backs at{' '}
              <strong>{finding.ratios['RB']?.toFixed(3) ?? '—'}</strong> — a separation of{' '}
              <strong>{finding.separation.toFixed(3)}</strong>, and in the same direction rather
              than opposite ones. Whatever small movement is there is the whole league&rsquo;s
              variance drifting together, which is not a scheme effect. So the claim came out of
              the model page and this page stopped implying it.
            </p>

            <div className="panel scroll-x mt-3">
              <table className="data-table" style={{ minWidth: '34rem' }}>
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Defense faced</th>
                    <th className="text-right">Player-weeks</th>
                    <th className="text-right" title="Spread of the standardised residual. 1.000 means the stated uncertainty was exactly right for this bucket.">
                      Residual spread
                    </th>
                    <th className="text-right" title="Share of outcomes above the stated 90th percentile. A ceiling effect would show up here first.">
                      Above p90
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {finding.buckets.map((bucket) => (
                    <tr key={`${bucket.position}-${bucket.bucket}`}>
                      <td className="font-semibold">{bucket.position}</td>
                      <td style={{ color: 'var(--ink-muted)' }}>{bucket.bucket}</td>
                      <td className="tabular text-right">{bucket.n.toLocaleString()}</td>
                      <td className="tabular text-right">{bucket.residualSd.toFixed(3)}</td>
                      <td className="tabular text-right">{(bucket.aboveP90 * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              Every bucket sits within a whisker of 1.000, and every &ldquo;above p90&rdquo; near
              10% — which is the spread calibration working, and the reason this test had the
              power to find an effect if there had been one. Shell posture is computed from prior
              seasons only, so no week is judged by play-by-play it produced.
            </p>
          </Section>
        )}

        <Section
          title="The trade every defense has to make"
            source="nflverse play-by-play, 2024-25 · opponent-adjusted"
          note={
            <>
              A defense cannot take away the deep ball and the run at the same time — two safeties
              deep is one fewer defender in the box. So every defense sits somewhere on one
              continuum, and where it sits decides which of your players it hurts.{' '}
              <strong>Playing it high</strong> caps quarterbacks and outside receivers, and hands
              volume to tight ends and backs. <strong>Loading the box</strong> does the opposite.
              <br />
              <span style={{ color: 'var(--ink-faint)' }}>
                Measured from {defenses.seasons.join(' and ')} play-by-play — depth of target, deep
                rate, yards after catch and rushing EPA allowed — not from coverage labels. Every
                rate is opponent-adjusted, so a defense that drew a soft schedule gets no credit
                for it.
              </span>
            </>
          }
        >
          <StatRow columns={4}>
            <StatTile
              label="Softest shell"
              value={softest?.team ?? '—'}
              sub={`${softest?.adotAllowed.toFixed(1)} yd aDOT allowed · ${((softest?.targetShareAllowed.TE ?? 0) * 100).toFixed(0)}% of targets to TEs`}
            />
            <StatTile
              label="Most loaded box"
              value={hardest?.team ?? '—'}
              sub={`${hardest?.adotAllowed.toFixed(1)} yd aDOT · ${((hardest?.targetShareAllowed.WR ?? 0) * 100).toFixed(0)}% of targets to WRs`}
            />
            <StatTile
              label="Most pressure"
              value={mostPressure?.team ?? '—'}
              sub={`${((mostPressure?.sackRate ?? 0) * 100).toFixed(1)}% sack rate`}
            />
            <StatTile
              label="League aDOT allowed"
              value={`${defenses.leagueAverage.adotAllowed?.toFixed(1)} yd`}
              sub={`${((defenses.leagueAverage.deepRateAllowed ?? 0) * 100).toFixed(1)}% thrown 20+ deep`}
            />
          </StatRow>
        </Section>

        {/* ---- the continuum ---------------------------------------------- */}
        <Section
          title="Every defense on the continuum"
          note={
            <>
              Sorted from the softest shell to the most loaded box. The bar is where each defense
              sits: right of centre it keeps everything in front of it, left of centre it dares you
              to throw deep and stops the run instead.
            </>
          }
          aside={
            <Legend
              items={[
                { label: 'keeps it in front', color: 'var(--good)' },
                { label: 'loaded box', color: 'var(--bad)' },
              ]}
            />
          }
        >
          <div className="panel scroll-x">
            <table className="data-table" style={{ minWidth: '58rem' }}>
              <thead>
                <tr>
                  <th style={{ width: '3rem' }}>Def</th>
                  <th style={{ width: '11rem' }}>Shell</th>
                  <th style={{ minWidth: '10rem' }}>Posture</th>
                  <th className="text-right" title="Average depth of target allowed">aDOT</th>
                  <th className="text-right" title="Share of attempts thrown 20+ yards downfield">Deep%</th>
                  <th className="text-right" title="Share of receiving yards allowed after the catch">YAC%</th>
                  <th style={{ width: '10rem' }}>Targets allowed</th>
                  <th className="text-right">Sack%</th>
                  <th className="text-right" title="Opponent-adjusted EPA per dropback allowed">Pass EPA</th>
                  <th className="text-right" title="Opponent-adjusted EPA per rush allowed">Rush EPA</th>
                </tr>
              </thead>
              <tbody>
                {byShell.map((defense) => (
                  <tr key={defense.team}>
                    <td className="font-semibold">{defense.team}</td>
                    <td>
                      <DivergingBar value={defense.shellIndex} max={2.2} width={100} height={10} />
                    </td>
                    <td className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                      {shellLabel(defense.shellIndex)}
                    </td>
                    <td className="tabular text-right">{defense.adotAllowed.toFixed(1)}</td>
                    <td className="tabular text-right">{formatPct(defense.deepRateAllowed, 1)}</td>
                    <td className="tabular text-right">{formatPct(defense.yacShareAllowed)}</td>
                    <td>
                      <StackedBar
                        max={1}
                        width={140}
                        height={13}
                        showLabels={false}
                        segments={[
                          { key: 'WR', value: defense.targetShareAllowed.WR ?? 0, color: positionColor('WR') },
                          { key: 'TE', value: defense.targetShareAllowed.TE ?? 0, color: positionColor('TE') },
                          { key: 'RB', value: defense.targetShareAllowed.RB ?? 0, color: positionColor('RB') },
                        ]}
                      />
                    </td>
                    <td className="tabular text-right">{formatPct(defense.sackRate, 1)}</td>
                    <td
                      className="tabular text-right"
                      style={{ color: defense.passEpaAdjusted < 0 ? 'var(--good)' : 'var(--bad)' }}
                    >
                      {defense.passEpaAdjusted >= 0 ? '+' : ''}
                      {defense.passEpaAdjusted.toFixed(3)}
                    </td>
                    <td
                      className="tabular text-right"
                      style={{ color: defense.rushEpaAdjusted < 0 ? 'var(--good)' : 'var(--bad)' }}
                    >
                      {defense.rushEpaAdjusted >= 0 ? '+' : ''}
                      {defense.rushEpaAdjusted.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ---- the trade, drawn -------------------------------------------- */}
        <Section
          title="The trade, drawn"
          note={
            <>
              Deep passing allowed against rushing allowed. If the trade were free the dots would
              scatter at random; instead the good defenses sit toward the bottom-left and everyone
              else has to pick a side. A defense in the top-left is the one your tight end and your
              running back both want.
            </>
          }
        >
          <div className="panel p-3">
            <Scatter
              xLabel="Deep attempts allowed (20+ yds) →"
              yLabel="Adjusted rush EPA allowed →"
              quadrantLabels={[
                'Nothing deep, run works',
                'Gives up everything',
                'Shots allowed, run stuffed',
                'Nothing deep, run stuffed',
              ]}
              points={all.map((defense) => ({
                key: defense.team,
                x: defense.deepRateAllowed,
                y: defense.rushEpaAdjusted,
                label: `${defense.team} — ${(defense.deepRateAllowed * 100).toFixed(1)}% deep allowed, ${defense.rushEpaAdjusted >= 0 ? '+' : ''}${defense.rushEpaAdjusted.toFixed(3)} rush EPA, ${shellLabel(defense.shellIndex)}`,
                color: defense.shellIndex > 0 ? 'var(--good)' : 'var(--bad)',
                radius: 4.5,
                href: `/league/${leagueId}/team/${defense.team}`,
              }))}
            />
            <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              Green plays it high, red loads the box. Hover any dot for the team.
            </p>
          </div>
        </Section>

        {/* ---- position funnels -------------------------------------------- */}
        <Section
          title="Where the targets go"
          note="Share of targets each defense allows to receivers, tight ends and backs. The spread is not subtle — the softest shell in the league gives tight ends half again as many targets as the tightest, which is worth more than most start/sit calls."
          aside={
            <Legend
              items={['WR', 'TE', 'RB'].map((p) => ({ label: p, color: positionColor(p) }))}
            />
          }
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {(['TE', 'RB'] as const).map((group) => {
              const sorted = [...all].sort(
                (a, b) => (b.targetShareAllowed[group] ?? 0) - (a.targetShareAllowed[group] ?? 0),
              );
              const max = Math.max(...sorted.map((d) => d.targetShareAllowed[group] ?? 0), 0.01);

              return (
                <div key={group} className="panel">
                  <div className="panel-head">
                    <span className="eyebrow">Most generous to {group}s</span>
                    <span className="axis-label">share of targets allowed</span>
                  </div>
                  <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                    {sorted.slice(0, 8).map((defense) => (
                      <div key={defense.team} className="flex items-center gap-3 px-3 py-1.5">
                        <span className="w-8 shrink-0 text-xs font-semibold">{defense.team}</span>
                        <CellBar
                          value={defense.targetShareAllowed[group] ?? 0}
                          max={max}
                          width={150}
                          color={positionColor(group)}
                          label={formatPct(defense.targetShareAllowed[group] ?? 0)}
                        />
                        <span className="ml-auto text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                          {shellLabel(defense.shellIndex)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      </RailLayout>
    </>
  );
}
