import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LeagueNav } from '@/components/LeagueNav';
import { Section } from '@/components/Section';
import { CellBar, PositionChip } from '@/components/charts/primitives';
import { loadLeague } from '@/lib/league-data';
import { loadOffense, offenseRead, rankOf, type TeamOffense } from '@/lib/offense';
import { loadArtifact, scoreFor } from '@/lib/projections';
import { requireSession } from '@/lib/session';

/**
 * Why does this offence produce what it does?
 *
 * The brief's §53, and the counterpart to the player page: a projection is a
 * claim about a player *and* about the offence he plays in, and only one half of
 * that was inspectable. A back's carries are bounded by his team's plays and
 * skewed by his team's pass rate, so "he is projected 11 points" is only half an
 * answer without "and his offence runs the fewest plays in the league".
 *
 * Everything here is a tendency rather than an efficiency, and tendencies are
 * choices — so none of it is opponent-adjusted. A coach who throws on early
 * downs does so against good defenses and bad ones alike; adjusting a choice for
 * opponent would subtract signal rather than noise. The defensive numbers, where
 * opponent adjustment is the whole point, live on the scheme page.
 */

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

const Metric = ({
  label,
  value,
  context,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly context: string;
  readonly tone?: string;
}) => (
  <div>
    <div className="eyebrow mb-1">{label}</div>
    <div className="tabular text-2xl font-semibold" style={tone === undefined ? {} : { color: tone }}>
      {value}
    </div>
    <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
      {context}
    </div>
  </div>
);

export default async function TeamPage({
  params,
}: {
  params: Promise<{ leagueId: string; abbr: string }>;
}) {
  const { leagueId, abbr } = await params;
  const team = abbr.toUpperCase();

  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  if (view === null) notFound();

  const { snapshot } = view;
  const rules = snapshot.league.scoring.raw;

  const [artifact, offenseArtifact] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadOffense(),
  ]);

  const offense: TeamOffense | undefined = offenseArtifact?.teams[team];
  if (offense === undefined && artifact === null) notFound();

  // Who this offence actually feeds, by projection. The ordering is the point:
  // team behaviour is only interesting through the players it reaches.
  const players = Object.values(artifact?.players ?? {})
    .filter((p) => p.team === team && ['QB', 'RB', 'WR', 'TE'].includes(p.position))
    .map((p) => ({ ...p, points: scoreFor(p, rules, null, snapshot.asOfWeek) }))
    .filter((p) => p.points > 1)
    .sort((a, b) => b.points - a.points)
    .slice(0, 14);

  const topPoints = players[0]?.points ?? 1;

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={`${snapshot.league.format} · week ${snapshot.asOfWeek}`}
        active="scheme"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-6xl px-5 pb-20 lg:ml-14">
        <h1 className="mb-1 text-3xl font-semibold tracking-tight">{team}</h1>
        <p className="mb-8 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Offensive tendencies from {offense?.season ?? snapshot.league.season} play-by-play
        </p>

        {offense === undefined ? (
          <Section title="No play-by-play" note="This team has no offensive tendencies exported.">
            <p className="max-w-2xl text-sm leading-relaxed">
              Rebuild with <code>model/export_offense.py</code>.
            </p>
          </Section>
        ) : (
          <>
            <Section title="What this offence does" note="Read off the numbers below.">
              <p className="max-w-2xl text-base leading-relaxed">{offenseRead(offense)}</p>
            </Section>

            <Section
              title="Volume and tempo"
              note="How many chances there are to go round. Fantasy points are bounded by snaps, and snaps vary between teams more than most projections admit."
            >
              <div className="flex flex-wrap gap-x-10 gap-y-5">
                <Metric
                  label="Plays per game"
                  value={offense.playsPerGame.toFixed(1)}
                  context={
                    rankOf(offense.playsPerGamePct) === null
                      ? 'league rank unavailable'
                      : `${rankOf(offense.playsPerGamePct)} of 32`
                  }
                />
                <Metric
                  label="Seconds per play"
                  value={offense.secondsPerPlay.toFixed(1)}
                  context="neutral situations only — a team protecting a lead is the score talking"
                />
              </div>
            </Section>

            <Section
              title="How they split it"
              note="Raw pass rate is mostly a record of game script, because teams that trail throw. Subtracting the league rate for the same down, distance and score leaves identity rather than circumstance — and identity is what persists into next week."
            >
              <div className="flex flex-wrap gap-x-10 gap-y-5">
                <Metric
                  label="Pass over expected"
                  value={`${offense.proe >= 0 ? '+' : '−'}${(Math.abs(offense.proe) * 100).toFixed(1)}%`}
                  context={
                    rankOf(offense.proePct) === null
                      ? 'vs the league in the same situations'
                      : `${rankOf(offense.proePct)} of 32 most pass-happy`
                  }
                  tone={offense.proe >= 0 ? 'var(--pos)' : 'var(--neg)'}
                />
                <Metric
                  label="Neutral pass rate"
                  value={pct(offense.neutralPassRate)}
                  context="with the game in the balance"
                />
                <Metric
                  label="Raw pass rate"
                  value={pct(offense.passRate)}
                  context="all situations, game script included"
                />
              </div>
            </Section>

            {offense.redZonePassRate !== undefined && (
              <Section
                title="Near the goal"
                note="Where touchdown equity is assigned — the noisiest and most valuable slice of a fantasy week. A team can be pass-first between the twenties and hand off every snap inside the five, and those two facts point at different players."
              >
                <div className="flex flex-wrap gap-x-10 gap-y-5">
                  <Metric
                    label="Red-zone pass rate"
                    value={pct(offense.redZonePassRate)}
                    context={`${offense.redZonePlays ?? 0} snaps inside the twenty`}
                  />
                  {offense.goalLinePassRate != null && (
                    <Metric
                      label="Goal-line pass rate"
                      value={pct(offense.goalLinePassRate)}
                      context={`${offense.goalLinePlays ?? 0} snaps inside the five`}
                    />
                  )}
                  {offense.redZoneTds !== undefined && (
                    <Metric
                      label="Red-zone touchdowns"
                      value={String(offense.redZoneTds)}
                      context="over the observed window"
                    />
                  )}
                </div>
              </Section>
            )}
          </>
        )}

        {players.length > 0 && (
          <Section
            title="Who it reaches"
            note="Projected points this week under this league's scoring. Team behaviour only matters through the players it feeds."
          >
            <table className="w-full max-w-2xl">
              <tbody>
                {players.map((player) => (
                  <tr key={player.playerId} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                    <td className="w-10 py-1.5">
                      <PositionChip position={player.position} />
                    </td>
                    <td className="py-1.5 pr-3 text-sm">
                      <Link
                        href={`/league/${leagueId}/player/${player.playerId}`}
                        className="hover:underline"
                      >
                        {player.name}
                      </Link>
                    </td>
                    <td className="py-1.5">
                      <CellBar value={player.points} max={topPoints} />
                    </td>
                    <td className="tabular w-14 py-1.5 text-right text-sm">
                      {player.points.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}
      </main>
    </>
  );
}
