import { LeagueNav } from '@/components/LeagueNav';
import { RailBlock, RailLayout } from '@/components/design/DrillRail';
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
import { loadArtifact } from '@/lib/projections';
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

  const [defenses, { players }, finding, artifact] = await Promise.all([
    loadDefenses(),
    buildUsage(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
    loadSchemeFinding(),
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
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

  const myRoster = new Set(
    snapshot.rosters.find((roster) => roster.teamId === view.myTeamId)?.playerIds.map(String) ?? [],
  );

  // Your players, each against the defense he actually faces this week.
  const myMatchups = players
    .filter((player) => myRoster.has(player.playerId) && player.active && player.points > 1)
    .flatMap((player) => {
      const opponent = opponentFrom(player.gameId, player.team);
      const defense = opponent === null ? undefined : defenses.teams[opponent];
      if (defense === undefined || opponent === null) return [];

      return [{ player, opponent, defense, effect: matchupFor(player.position, defense, all) }];
    })
    .sort((a, b) => b.player.points - a.player.points);

  /*
   * The margin each of your players has over the next man at his position.
   *
   * This is what turns a scheme read into a decision. A hostile matchup for a
   * receiver you would start anyway — because the alternative is four points
   * worse — is a fact about the defense, not a fact about your week, and the
   * page should not dress the two up the same way.
   *
   * Measured against the next-best player at the same position on your own
   * roster, which is the substitution actually available. The lineup page
   * computes a true slot margin against the optimal lineup; this one is
   * deliberately the simpler quantity and is labelled as such rather than
   * quietly reported as the same number.
   */
  const byPosition = new Map<string, number[]>();
  for (const { player } of myMatchups) {
    const bucket = byPosition.get(player.position) ?? [];
    bucket.push(player.points);
    byPosition.set(player.position, bucket);
  }
  for (const bucket of byPosition.values()) bucket.sort((a, b) => b - a);

  const nextBestAt = (position: string, points: number): { name: string; margin: number } | null => {
    const others = myMatchups.filter(
      (entry) => entry.player.position === position && entry.player.points < points,
    );
    const best = others[0];
    return best === undefined ? null : { name: best.player.name, margin: points - best.player.points };
  };

  const decisions = myMatchups.map((entry) => {
    const next = nextBestAt(entry.player.position, entry.player.points);
    const sd = artifact?.players[entry.player.playerId]?.sd ?? 0;
    return {
      ...entry,
      sd,
      verdict: callVerdict(next?.margin ?? 0, sd, next?.name ?? null, finding),
    };
  });

  const closeCalls = flippableCount(decisions.map((d) => d.verdict));

  const extreme = (of: (profile: DefenseProfile) => number, top: boolean) =>
    [...all].sort((a, b) => (top ? of(b) - of(a) : of(a) - of(b)))[0];

  const softest = extreme((d) => d.shellIndex, true);
  const hardest = extreme((d) => d.shellIndex, false);
  const mostPressure = extreme((d) => d.pressureIndex, true);

  return (
    <>
      {nav}

        <RailLayout
        rail={
          <LeagueRail view={view}>
            <RailBlock title="What this page answers">
              What each defense is trying to take away from your players this week — and, per
              player and in points, how much that is worth. Three measured attempts to turn the
              matchup into a number all failed, so scheme lives beside a projection rather than
              inside it, and the page says so rather than implying otherwise with a colour.
            </RailBlock>
          </LeagueRail>
        }
      >
          <div className="panel p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No defensive profile artifact. Build one with{' '}
            <code>python model/export_defense.py 2024 2025</code>.
          </div>
        {/* ---- your week, leading ----------------------------------------- */}
        {decisions.length > 0 && (
          <Section
            title={`Your week ${snapshot.asOfWeek} roster, against ${new Set(decisions.map((d) => d.opponent)).size} defenses`}
            source="nflverse play-by-play · scheme read displayed, never applied to the projection"
            note={
              <>
                Every player you are projected to start, the defense he faces, and{' '}
                <strong>whether the matchup can change the call</strong>. That last column is the
                one that was missing: a hostile read next to a player whose replacement is four
                points worse is a fact about the defense, not a fact about your lineup.
                <br />
                <span style={{ color: 'var(--ink-faint)' }}>
                  The bound comes from the variance study below — the largest movement scheme could
                  produce for that player without {finding === null ? 'the study' : `${finding.n.toLocaleString()} player-weeks`}{' '}
                  having detected it.
                </span>
              </>
            }
          >
            <StatRow columns={3}>
              <StatTile
                label="Calls scheme could reach"
                value={`${closeCalls} of ${decisions.length}`}
                sub={
                  closeCalls === 0
                    ? 'every start/sit margin is wider than the matchup is worth'
                    : 'margins narrow enough that the read is not irrelevant'
                }
              />
              <StatTile
                label="Widest bound on your roster"
                value={`±${Math.max(0, ...decisions.map((d) => d.verdict.bound)).toFixed(2)} pts`}
                sub="most scheme could move any one of your players"
              />
              <StatTile
                label="Toughest read"
                value={
                  [...decisions].sort((a, b) => a.effect.score - b.effect.score)[0]?.player.name ?? '—'
                }
                sub={[...decisions].sort((a, b) => a.effect.score - b.effect.score)[0]?.effect.headline ?? ''}
              />
            </StatRow>

            <div className="mt-3 grid gap-2">
              {decisions.map(({ player, opponent, defense, effect, verdict }) => (
                <article
                  key={player.playerId}
                  className="panel p-3"
                  style={
                    verdict.couldFlip
                      ? { borderColor: 'var(--accent)', borderWidth: 1 }
                      : undefined
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <PositionChip position={player.position} />
                    <span className="text-sm font-semibold">{player.name}</span>
                    <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                      {player.team} vs {opponent}
                    </span>
                    <span
                      className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      style={{ background: 'var(--surface-sunk)', color: scoreColor(effect.score) }}
                      title={`Scheme read: ${effect.headline}. Displayed only — never applied to the projection.`}
                    >
                      {effect.headline}
                    </span>
                    <DivergingBar value={effect.score} max={1} width={90} height={9} />
                  </div>

                  {/*
                    * The decision sentence sits above the description, not below
                    * it. A reader who stops after one line should stop having
                    * learned whether to act, not having learned a coverage stat.
                    */}
                  <p
                    className="mt-1.5 text-xs font-semibold leading-relaxed"
                    style={{ color: verdict.couldFlip ? 'var(--accent)' : 'var(--ink)' }}
                  >
                    {verdict.sentence}
                  </p>

                  <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                    {effect.detail}
                  </p>

                  <div
                    className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]"
                    style={{ color: 'var(--ink-faint)' }}
                  >
                    <span>
                      {opponent} shell{' '}
                      <strong style={{ color: 'var(--ink-muted)' }}>{shellLabel(defense.shellIndex)}</strong>
                    </span>
                    <span>
                      projected{' '}
                      <strong style={{ color: 'var(--ink-muted)' }}>{player.points.toFixed(1)} pts</strong>
                    </span>
                    <span>
                      opportunity{' '}
                      <strong style={{ color: 'var(--ink-muted)' }}>{player.opportunities.toFixed(1)}</strong>
                    </span>
                  </div>
                </article>
              ))}
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
