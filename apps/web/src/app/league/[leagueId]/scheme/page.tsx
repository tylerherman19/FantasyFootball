import { LeagueNav } from '@/components/LeagueNav';
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
import { leagueMeta, lineupShape, loadLeague } from '@/lib/league-data';
import { requireSession } from '@/lib/session';
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

  const [defenses, { players }] = await Promise.all([
    loadDefenses(),
    buildUsage(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
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
        <main className="mx-auto max-w-6xl px-5 pb-20">
          <div className="panel p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No defensive profile artifact. Build one with{' '}
            <code>python model/export_defense.py 2024 2025</code>.
          </div>
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

  const extreme = (of: (profile: DefenseProfile) => number, top: boolean) =>
    [...all].sort((a, b) => (top ? of(b) - of(a) : of(a) - of(b)))[0];

  const softest = extreme((d) => d.shellIndex, true);
  const hardest = extreme((d) => d.shellIndex, false);
  const mostPressure = extreme((d) => d.pressureIndex, true);

  return (
    <>
      {nav}

      <main className="mx-auto max-w-6xl px-5 pb-20">
        <Section
          title="The trade every defense has to make"
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

        {/* ---- your players against their actual opponents ---------------- */}
        {myMatchups.length > 0 && (
          <Section
            title={`Your players, week ${snapshot.asOfWeek}`}
            note="Each of your projected players against the defense he actually lines up against, with the read that follows from that defense's tendencies. Green is a matchup that works with what he does; red is one that fights it."
          >
            <div className="grid gap-2">
              {myMatchups.map(({ player, opponent, defense, effect }) => (
                <article key={player.playerId} className="panel p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <PositionChip position={player.position} />
                    <span className="text-sm font-semibold">{player.name}</span>
                    <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                      {player.team} vs {opponent}
                    </span>
                    <span
                      className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      style={{
                        background: 'var(--surface-sunk)',
                        color: scoreColor(effect.score),
                      }}
                    >
                      {effect.headline}
                    </span>
                    <DivergingBar value={effect.score} max={1} width={90} height={9} />
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                    {effect.detail}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                    <span>{opponent} shell <strong style={{ color: 'var(--ink-muted)' }}>{shellLabel(defense.shellIndex)}</strong></span>
                    <span>projected <strong style={{ color: 'var(--ink-muted)' }}>{player.points.toFixed(1)} pts</strong></span>
                    <span>opportunity <strong style={{ color: 'var(--ink-muted)' }}>{player.opportunities.toFixed(1)}</strong></span>
                  </div>
                </article>
              ))}
            </div>
          </Section>
        )}

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
      </main>
    </>
  );
}
