import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LeagueNav } from '@/components/LeagueNav';
import { Section } from '@/components/Section';
import { Confidence, Why } from '@/components/Why';
import { PositionChip, RangeBar } from '@/components/charts/primitives';
import {
  careerPhase,
  loadAgeCurves,
  multiYearValue,
  remainingPeakSeasons,
  shareOfPeak,
  yearByYearOutlook,
} from '@/lib/age-curves';
import { explain, usageRows } from '@/lib/explain';
import { loadHistory, reliabilityLabel, trendLabel } from '@/lib/history';
import { loadLeague } from '@/lib/league-data';
import { requireSession } from '@/lib/session';
import { loadAvailability } from '@/lib/availability';
import { loadIdentities } from '@/lib/crosswalk';
import { loadArtifact } from '@/lib/projections';
import { loadOffense, offenseRead, rankOf } from '@/lib/offense';
import { loadMarketValues } from '@/lib/values';

/**
 * Should I believe in this player?
 *
 * The audit called this the largest single gap in the product: for an
 * application whose central question is whether to trust a number, there was
 * nowhere to go and look at the number. Every other page quotes a projection;
 * this is the page that has to justify one.
 *
 * League-scoped rather than global, because none of these answers are
 * league-independent. Points come from this league's rules, market value from
 * this league's format, and replacement level from this league's starters. A
 * global player page would have to pick one and be wrong for the other two.
 *
 * Ordered the way 538 orders a story: the conclusion, then why, then the
 * evidence, then the caveats. Not a grid of statistics for the reader to
 * assemble into a view.
 */

const age = (birthdate: string | null): number | null => {
  if (birthdate === null) return null;
  const born = Date.parse(birthdate);
  if (Number.isNaN(born)) return null;
  return (Date.now() - born) / (365.25 * 24 * 60 * 60 * 1000);
};

/** A one-line read, derived from the decomposition rather than written about it. */
const verdict = (
  name: string,
  position: string,
  opportunity: number,
  efficiency: number,
  isPrior: boolean,
): string => {
  if (isPrior) {
    return `${name} has never taken an NFL snap. This projection is draft capital and a depth chart, and it should move a lot once real games arrive.`;
  }
  if (opportunity > 3 && efficiency < 1) {
    return `${name} is a volume play: nearly all of his projection is opportunity, not efficiency. That is the durable kind — usage repeats far better than yards per touch.`;
  }
  if (efficiency > 3 && opportunity < 2) {
    return `${name} is priced on efficiency rather than usage, which is the fragile combination: the model regresses efficiency hard, and a role that thin leaves no floor if the rate slips.`;
  }
  if (opportunity < 0 && efficiency < 0) {
    return `${name} projects below an average ${position} on both usage and efficiency. There is no case here beyond injury insurance.`;
  }
  return `${name} clears the average ${position} on usage and holds his own on efficiency.`;
};

export default async function PlayerPage({
  params,
}: {
  params: Promise<{ leagueId: string; playerId: string }>;
}) {
  const { leagueId, playerId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  if (view === null) notFound();

  const { snapshot, teamNames } = view;
  const rules = snapshot.league.scoring.raw;

  const [artifact, identities, availability, values, history] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadIdentities(),
    loadAvailability(),
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex),
    loadHistory().catch(() => null),
  ]);
  const [ageCurves, offenseArtifact] = await Promise.all([
    loadAgeCurves().catch(() => null),
    loadOffense().catch(() => null),
  ]);

  const player = artifact?.players[playerId];
  const identity = identities[playerId];
  if (player === undefined && identity === undefined) notFound();

  const name = player?.name || identity?.name || playerId;
  const position = player?.position ?? identity?.position ?? '?';
  const team = player?.team ?? identity?.team ?? '';
  const injuryStatus = availability[playerId]?.injuryStatus ?? null;
  const market = values.get(playerId);
  const years = age(identity?.birthdate ?? null);

  const explanation = player === undefined ? null : explain(player, rules, injuryStatus);
  const usage = player === undefined ? [] : usageRows(player);
  const past = history?.bySleeperId.get(playerId) ?? null;

  const opportunity = explanation?.steps[1]?.value ?? 0;
  const efficiency = explanation?.steps[2]?.value ?? 0;

  const offense = offenseArtifact?.teams[team];
  const share = shareOfPeak(ageCurves, position, years);
  const remaining = remainingPeakSeasons(ageCurves, position, years, 4);
  const phase = careerPhase(ageCurves, position, years);
  const outlook = yearByYearOutlook(ageCurves, position, years, 5);
  const fourYear = multiYearValue(ageCurves, position, years, 4);

  const owner = snapshot.rosters.find((roster) =>
    roster.playerIds.some((id) => String(id) === playerId),
  );

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={`${snapshot.league.format} · week ${snapshot.asOfWeek}`}
        active="roster"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-6xl px-5 pb-20 lg:ml-14">
        <div className="mb-8">
          <div className="flex flex-wrap items-baseline gap-3">
            <PositionChip position={position} />
            <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
            <span className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              {team === '' ? (
                ''
              ) : (
                <Link href={`/league/${leagueId}/team/${team}`} className="hover:underline">
                  {team}
                </Link>
              )}
              {years !== null && ` · ${years.toFixed(1)} yrs`}
              {player?.byeWeek != null && ` · bye ${player.byeWeek}`}
            </span>
            {injuryStatus !== null && (
              <span className="text-sm font-medium" style={{ color: 'var(--warn)' }}>
                {injuryStatus}
              </span>
            )}
          </div>

          <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {owner === undefined
              ? 'Free agent in this league'
              : `Rostered by ${teamNames.get(owner.managerId) ?? owner.teamId}`}
            {player?.basis === 'rookie-prior' && ' · rookie, no NFL history'}
          </p>
        </div>

        {/* Every number in context, per §67: never a bare figure. */}
        <div className="mb-9 flex flex-wrap gap-x-10 gap-y-4">
          <div>
            <div className="eyebrow mb-1">Weekly projection</div>
            <div className="tabular text-2xl font-semibold">
              {explanation === null ? '—' : explanation.total.toFixed(1)}
            </div>
            <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
              {explanation === null ? 'not projected' : `${snapshot.league.name} scoring`}
            </div>
          </div>

          {player !== undefined && (
            <div>
              <div className="eyebrow mb-1">Weekly range</div>
              <RangeBar
                value={explanation?.total ?? 0}
                low={Math.max(0, (explanation?.total ?? 0) - player.sd)}
                high={(explanation?.total ?? 0) + player.sd}
                min={0}
                max={Math.max(30, (explanation?.total ?? 0) + player.sd * 1.2)}
              />
              <div className="tabular mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                {Math.max(0, (explanation?.total ?? 0) - player.sd).toFixed(1)} –{' '}
                {((explanation?.total ?? 0) + player.sd).toFixed(1)} on a typical week
              </div>
            </div>
          )}

          {market !== undefined && (
            <div>
              <div className="eyebrow mb-1">Market value</div>
              <div className="tabular text-2xl font-semibold">{market.value.toLocaleString()}</div>
              <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                #{market.overallRank} overall
                {market.rosteredPct !== null && ` · rostered in ${market.rosteredPct.toFixed(0)}%`}
              </div>
            </div>
          )}

          {explanation !== null && (
            <div>
              <div className="eyebrow mb-1">Confidence</div>
              <Confidence explanation={explanation} />
            </div>
          )}
        </div>

        {explanation === null ? (
          <Section
            title="Model verdict"
            note="This player is on an NFL roster but the model has no projection for him."
          >
            <p className="max-w-2xl text-sm leading-relaxed">
              The usage model builds a projection from a player&rsquo;s own history and the rookie
              prior covers players with none. Anyone reaching this message is neither — most often
              a kicker, an IDP or a team defense, which are projected by a separate positional model
              and not decomposed here.
            </p>
          </Section>
        ) : (
          <>
            <Section title="Model verdict" note="Read off the decomposition below, not written about it.">
              <p className="max-w-2xl text-base leading-relaxed">
                {verdict(name, position, opportunity, efficiency, explanation.isPrior)}
              </p>
            </Section>

            <Section
              title="Why this number"
              note="Each bar is a term the model actually computed. They sum to the projection exactly."
            >
              <Why explanation={explanation} className="max-w-2xl" />
            </Section>
          </>
        )}

        {usage.length > 0 && (
          <Section
            title="Usage"
            note="Projected per game against what he has actually been doing, recency-weighted. Where the two disagree, the model is regressing him toward his position."
          >
            <table className="w-full max-w-lg">
              <thead>
                <tr className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  <th className="pb-1 text-left font-normal">Per game</th>
                  <th className="pb-1 text-right font-normal">Recent</th>
                  <th className="pb-1 text-right font-normal">Projected</th>
                  <th className="pb-1 text-right font-normal">Shift</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => {
                  const delta = row.projected - row.observed;
                  return (
                    <tr key={row.label} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                      <td className="py-1.5 text-sm">{row.label}</td>
                      <td className="tabular py-1.5 text-right text-sm">{row.observed.toFixed(1)}</td>
                      <td className="tabular py-1.5 text-right text-sm font-medium">
                        {row.projected.toFixed(1)}
                      </td>
                      <td
                        className="tabular py-1.5 text-right text-sm"
                        style={{ color: delta >= 0 ? 'var(--pos)' : 'var(--neg)' }}
                      >
                        {delta >= 0 ? '+' : '−'}
                        {Math.abs(delta).toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Section>
        )}

        {offense !== undefined && (
          <Section
            title="The offence he plays in"
            note="Usage is downstream of team behaviour. A back on a fast, run-first offence sees carries a back on a slow, pass-first one never will, and no amount of player-level modelling recovers that."
          >
            <p className="mb-4 max-w-2xl text-base leading-relaxed">{offenseRead(offense)}</p>

            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <div>
                <div className="eyebrow mb-1">Plays per game</div>
                <div className="tabular text-xl font-semibold">
                  {offense.playsPerGame.toFixed(1)}
                </div>
                <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  {rankOf(offense.playsPerGamePct) !== null &&
                    `${rankOf(offense.playsPerGamePct)} of 32`}
                </div>
              </div>

              <div>
                <div className="eyebrow mb-1">Pass over expected</div>
                <div
                  className="tabular text-xl font-semibold"
                  style={{ color: offense.proe >= 0 ? 'var(--pos)' : 'var(--neg)' }}
                >
                  {offense.proe >= 0 ? '+' : '−'}
                  {(Math.abs(offense.proe) * 100).toFixed(1)}%
                </div>
                <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  vs the league in the same situations
                </div>
              </div>

              <div>
                <div className="eyebrow mb-1">Neutral pass rate</div>
                <div className="tabular text-xl font-semibold">
                  {(offense.neutralPassRate * 100).toFixed(0)}%
                </div>
                <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  with the game in the balance
                </div>
              </div>

              {offense.redZonePassRate !== undefined && (
                <div>
                  <div className="eyebrow mb-1">Red-zone pass rate</div>
                  <div className="tabular text-xl font-semibold">
                    {(offense.redZonePassRate * 100).toFixed(0)}%
                  </div>
                  <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                    where touchdown equity is assigned
                  </div>
                </div>
              )}

              <div>
                <div className="eyebrow mb-1">Seconds per play</div>
                <div className="tabular text-xl font-semibold">
                  {offense.secondsPerPlay.toFixed(1)}
                </div>
                <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  neutral situations only
                </div>
              </div>
            </div>
          </Section>
        )}

        {share !== null && (
          <Section
            title="Career phase"
            note="Fitted on ten seasons by the delta method — each player compared to himself a year later, so his own level cancels and only the age effect survives. Comparing players by age instead would measure who survived, not how they aged."
          >
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <div>
                <div className="eyebrow mb-1">Against his peak</div>
                <div className="tabular text-2xl font-semibold">{(share * 100).toFixed(0)}%</div>
                <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  of what an average {position} produces at {position === 'QB' ? '24' : 'his best age'}
                </div>
              </div>

              {phase !== null && (
                <div>
                  <div className="eyebrow mb-1">Direction</div>
                  <div
                    className="text-2xl font-semibold capitalize"
                    style={{
                      color:
                        phase === 'ascending'
                          ? 'var(--pos)'
                          : phase === 'declining'
                            ? 'var(--neg)'
                            : 'var(--ink)',
                    }}
                  >
                    {phase}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                    next season vs this one
                  </div>
                </div>
              )}

              {remaining !== null && (
                <div>
                  <div className="eyebrow mb-1">Next four years</div>
                  <div className="tabular text-2xl font-semibold">{remaining.toFixed(1)}</div>
                  <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                    peak-equivalent seasons remaining
                  </div>
                </div>
              )}
            </div>

            <p className="mt-3 max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              Read as a floor on decline. The method only counts players who appeared in both
              seasons, so it cannot see the ones whose careers ended — which means real cohorts fall
              off faster than this.
            </p>
          </Section>
        )}

        {outlook.some((v) => v !== null) && explanation !== null && (
          <Section
            title="The next five years"
            note="Each season as a share of what he produces now, from his position's fitted curve. Undiscounted on purpose — how much sooner-is-better matters to you is the contend-or-rebuild question, and answering it twice would be answering it wrong."
          >
            <table className="w-full max-w-xl">
              <thead>
                <tr className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  <th className="pb-1 text-left font-normal">Season</th>
                  <th className="pb-1 text-right font-normal">Age</th>
                  <th className="pb-1 text-right font-normal">vs today</th>
                  <th className="pb-1 text-right font-normal">Weekly points</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-1.5 text-sm font-medium">Now</td>
                  <td className="tabular py-1.5 text-right text-sm">
                    {years === null ? '—' : years.toFixed(1)}
                  </td>
                  <td className="tabular py-1.5 text-right text-sm">1.00</td>
                  <td className="tabular py-1.5 text-right text-sm font-medium">
                    {explanation.total.toFixed(1)}
                  </td>
                </tr>
                {outlook.map((ratio, index) => (
                  <tr
                    key={index}
                    className="border-t"
                    style={{ borderColor: 'var(--rule)' }}
                  >
                    <td className="py-1.5 text-sm">+{index + 1}</td>
                    <td className="tabular py-1.5 text-right text-sm">
                      {years === null ? '—' : (years + index + 1).toFixed(1)}
                    </td>
                    <td
                      className="tabular py-1.5 text-right text-sm"
                      style={{
                        color:
                          ratio === null
                            ? 'var(--ink-faint)'
                            : ratio >= 1
                              ? 'var(--pos)'
                              : 'var(--neg)',
                      }}
                    >
                      {ratio === null ? 'unknown' : ratio.toFixed(2)}
                    </td>
                    <td className="tabular py-1.5 text-right text-sm">
                      {ratio === null ? '—' : (explanation.total * ratio).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {fourYear !== null && (
              <p className="mt-3 max-w-2xl text-sm leading-relaxed">
                Over four years he is worth about{' '}
                <strong className="tabular">{fourYear.toFixed(1)}</strong> of his current seasons.
                That is the number to compare against another player at a different point on the
                same curve — it prices seasons still to come at what each man is worth today.
              </p>
            )}

            {outlook.some((v) => v === null) && (
              <p className="mt-2 max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                Seasons marked unknown fall outside the fitted range. The curve declines to guess
                rather than extrapolate off its own end.
              </p>
            )}
          </Section>
        )}

        {past !== null && (
          <Section
            title="History"
            note="Completed seasons, as the model sees them. Reliability is how consistently he has produced, not how much."
          >
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              {reliabilityLabel(past)}
              {trendLabel(past) !== null && ` · ${trendLabel(past)}`}
            </p>
          </Section>
        )}
      </main>
    </>
  );
}
