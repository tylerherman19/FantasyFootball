import {
  optimalLineup,
  asPlayerId,
  SLOT_ELIGIBILITY,
  type LineupCandidate,
  type LineupSlot,
  type Position,
} from '@ffe/core';
import Link from 'next/link';
import { LeagueNav } from '@/components/LeagueNav';
import { RailBlock, RailLayout } from '@/components/design/DrillRail';
import { LeagueRail } from '@/components/design/LeagueRail';
import { requireSession } from '@/lib/session';
import { LineupBoard, type LineupSlotView } from '@/components/LineupBoard';
import { StarterMatchups, type StarterMatchup } from '@/components/StarterMatchups';
import { loadDefenses, matchupFor, opponentFrom } from '@/lib/defense';
import { callVerdict, flippableCount, loadSchemeFinding } from '@/lib/scheme-impact';
import { Section, StatRow, StatTile } from '@/components/Section';
import {
  CellBar,
  Legend,
  PositionChip,
  StackedBar,
  formatPct,
  positionColor,
} from '@/components/charts/primitives';
import { buildUsage } from '@/lib/usage';
import { loadAvailability } from '@/lib/availability';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { isPlayingIn, loadArtifact, scoreFor } from '@/lib/projections';
import { serializeLeague } from '@/lib/serialize';
import { loadMarketValues } from '@/lib/values';

export default async function LineupPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);
  const { snapshot, myTeamId } = view;

  const [artifact, availability, values, playerInfo] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadAvailability(),
    loadMarketValues(snapshot),
    loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
  ]);

  const roster = myTeamId === null ? undefined : snapshot.rosters.find((r) => r.teamId === myTeamId);
  const rules = snapshot.league.scoring.raw;

  const describe = (playerId: string, projected: number): Omit<LineupSlotView, 'slot' | 'playerId'> => {
    const projection = artifact?.players[playerId];
    return {
      name: projection?.name ?? playerInfo[playerId]?.name ?? playerId,
      position: projection?.position ?? playerInfo[playerId]?.position ?? '?',
      team: projection?.team ?? playerInfo[playerId]?.team ?? '',
      projected,
      sd: projection?.sd ?? 0,
      injuryStatus: availability[playerId]?.injuryStatus ?? null,
    };
  };

  const candidates: LineupCandidate[] = (roster?.playerIds ?? []).flatMap((id) => {
    const projection = artifact?.players[String(id)];
    if (projection === undefined || !isPlayingIn(projection, snapshot.asOfWeek)) return [];

    const position = projection.position as Position;
    const status = availability[String(id)]?.injuryStatus ?? null;

    return [
      {
        playerId: asPlayerId(String(id)),
        position,
        eligiblePositions: [position],
        projectedPoints: scoreFor(projection, rules, status, snapshot.asOfWeek),
        stddev: projection.sd,
      },
    ];
  });

  const lineup = optimalLineup(candidates, snapshot.league.rosterSlots);

  const slots: LineupSlotView[] = lineup.slots.map((slot) => {
    const id = slot.playerId === null ? null : String(slot.playerId);
    return {
      slot: slot.slot,
      playerId: id,
      ...(id === null
        ? { name: 'empty', position: '—', team: '', projected: 0, sd: 0, injuryStatus: null }
        : describe(id, slot.projectedPoints)),
    };
  });

  const bench: LineupSlotView[] = lineup.bench.map((player) => ({
    slot: 'BN',
    playerId: String(player.playerId),
    ...describe(String(player.playerId), player.projectedPoints),
  }));

  /*
   * Scheme context for the players actually being started.
   *
   * The numbers live on their own page, which is the wrong place to read them:
   * a matchup only matters where the start/sit call is made. Only starters, and
   * only the positions a scheme read says anything useful about — a kicker's
   * week is not decided by coverage shell.
   */
  const [defenses, schemeFinding] = await Promise.all([loadDefenses(), loadSchemeFinding()]);
  const SCHEME_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

  /*
   * What each starter is actually being started *over*.
   *
   * This is the number the matchup has to beat to matter. Without it a hostile
   * read is just a red word next to a player the manager was always going to
   * start, and the page has spent its most prominent real estate telling him
   * something with no action attached.
   *
   * Eligibility comes from the slot, not the position, so a back in the FLEX is
   * correctly compared against the best receiver on the bench as well.
   */
  const alternativeFor = (slot: LineupSlotView): { name: string; margin: number } | null => {
    const eligible = SLOT_ELIGIBILITY[slot.slot as LineupSlot];
    if (eligible === null || eligible === undefined || slot.playerId === null) return null;

    const best = [...bench]
      .filter((candidate) => eligible.includes(candidate.position as Position))
      .sort((a, b) => b.projected - a.projected)[0];

    return best === undefined ? null : { name: best.name, margin: slot.projected - best.projected };
  };

  const matchups: StarterMatchup[] = slots.flatMap((slot) => {
    if (slot.playerId === null || !SCHEME_POSITIONS.has(slot.position)) return [];
    if (defenses === null) return [];

    const projection = artifact?.players[slot.playerId];
    const opponent =
      projection === undefined ? null : opponentFrom(projection.gameId, slot.team);
    const profile = opponent === null ? undefined : defenses.teams[opponent];

    return [
      {
        playerId: slot.playerId,
        name: slot.name,
        position: slot.position,
        team: slot.team,
        opponent,
        projected: slot.projected,
        sd: slot.sd,
        effect:
          profile === undefined
            ? null
            : matchupFor(slot.position, profile, Object.values(defenses.teams)),
        verdict: (() => {
          const alternative = alternativeFor(slot);
          return callVerdict(alternative?.margin ?? 0, slot.sd, alternative?.name ?? null, schemeFinding);
        })(),
      },
    ];
  });

  const schemeCanReach = flippableCount(matchups.flatMap((m) => (m.verdict ? [m.verdict] : [])));

  const total = slots.reduce((sum, slot) => sum + slot.projected, 0);
  const hurtStarters = slots.filter((slot) => slot.injuryStatus !== null);
  const emptySlots = slots.filter((slot) => slot.playerId === null);

  const wire = serializeLeague(view, values, playerInfo);

  const { players: usageAll } = await buildUsage(
    snapshot.league.season,
    snapshot.asOfWeek,
    snapshot.league.scoring.raw,
  );
  const usageOf = new Map(usageAll.map((player) => [player.playerId, player]));

  // The spread matters as much as the total: a lineup built on volume floors
  // and one built on touchdown lottery tickets can project identically and
  // deliver completely different weeks.
  const lineupSd = Math.sqrt(slots.reduce((sum, slot) => sum + slot.sd ** 2, 0));
  const filled = slots.filter((slot) => slot.playerId !== null);

  const tdShare =
    filled.reduce((sum, slot) => sum + (usageOf.get(slot.playerId ?? '')?.tdDependence ?? 0) * slot.projected, 0) /
    Math.max(total, 1e-9);

  // Points by position, so the shape of the week is visible at a glance.
  const byPosition = new Map<string, number>();
  for (const slot of filled) {
    byPosition.set(slot.position, (byPosition.get(slot.position) ?? 0) + slot.projected);
  }

  const maxSlotPoints = Math.max(...slots.map((slot) => slot.projected), ...bench.map((p) => p.projected), 1);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="lineup"
        format={snapshot.league.format}
        stamps={[
          { label: 'Week', value: String(snapshot.asOfWeek) },
          { label: 'Projected', value: total.toFixed(1) },
          { label: 'Spread', value: `±${lineupSd.toFixed(1)}` },
        ]}
      />

      <RailLayout
        rail={
          <LeagueRail view={view}>
            <RailBlock title="What this page answers">
              Start/sit is priced in title odds, not points. The question is not who scores more but which choice makes you more likely to win the league.
            </RailBlock>
          </LeagueRail>
        }
      >
        {/*
         * The week stated, including what is wrong with it.
         *
         * A projection alone reads as a promise. Pairing it with the spread and
         * naming the two things a manager can actually act on — a flagged
         * starter and an unfilled slot — turns a number into a to-do list.
         */}
        <div
          className="mb-5 border-l-2 px-4 py-3 text-sm leading-relaxed"
          style={{ borderColor: 'var(--accent)', background: 'var(--surface-sunk)' }}
        >
          <strong>
            Your best legal lineup projects {total.toFixed(1)} points, give or take{' '}
            {lineupSd.toFixed(1)}.
          </strong>{' '}
          <span style={{ color: 'var(--ink-muted)' }}>
            {emptySlots.length > 0 && (
              <>
                {emptySlots.length} slot{emptySlots.length === 1 ? '' : 's'} sit empty (
                {emptySlots.map((slot) => slot.slot).join(', ')}) and will score zero until filled —
                that is the first thing to fix.{' '}
              </>
            )}
            {hurtStarters.length > 0 && (
              <>
                {hurtStarters.map((slot) => slot.name).join(' and ')}{' '}
                {hurtStarters.length === 1 ? 'carries' : 'carry'} an injury designation and{' '}
                {hurtStarters.length === 1 ? 'is' : 'are'} already discounted by the chance of
                playing.{' '}
              </>
            )}
            {emptySlots.length === 0 && hurtStarters.length === 0 && (
              <>Nothing is flagged and every slot is filled. </>
            )}
            The lineup is solved rather than sorted, so in superflex it will start two quarterbacks
            when the arithmetic says so.
          </span>
        </div>
        <Section
          title={`Week ${snapshot.asOfWeek}`}
          note={
            <>
              The lineup is solved rather than sorted — in superflex that means starting two
              quarterbacks when the arithmetic says so, which greedy ordering gets wrong. Injured
              players are discounted by their chance of playing, and ruled-out players cannot be
              started at all.
            </>
          }
        >
          <StatRow columns={5}>
            <StatTile label="Projection" value={total.toFixed(1)} sub="starting lineup" />
            <StatTile
              label="Realistic range"
              value={`${Math.max(0, total - lineupSd).toFixed(0)}–${(total + lineupSd).toFixed(0)}`}
              sub="one standard deviation"
            />
            <StatTile
              label="TD dependence"
              value={formatPct(tdShare)}
              sub="of projected points"
              tone={tdShare > 0.32 ? 'warn' : undefined}
            />
            <StatTile
              label="Flagged starters"
              value={String(hurtStarters.length)}
              sub={hurtStarters.length === 0 ? 'all clear' : hurtStarters.map((s) => s.name).join(', ')}
              tone={hurtStarters.length > 0 ? 'bad' : 'good'}
            />
            <StatTile
              label="Empty slots"
              value={String(emptySlots.length)}
              sub={emptySlots.length === 0 ? 'lineup full' : emptySlots.map((s) => s.slot).join(', ')}
              tone={emptySlots.length > 0 ? 'bad' : undefined}
            />
          </StatRow>
        </Section>

        {byPosition.size > 0 && (
          <Section
            title="Where this week's points come from"
            source="model v1-usage+positional · projections rebuilt weekly"
            note="Projected starting points by position. A week concentrated in one place is a week that lives or dies with one game script."
            aside={
              <Legend
                items={[...byPosition.keys()].map((position) => ({
                  label: position,
                  color: positionColor(position),
                }))}
              />
            }
          >
            <div className="panel p-3">
              <StackedBar
                max={total}
                width={640}
                height={26}
                segments={[...byPosition.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([position, points]) => ({
                    key: position,
                    value: points,
                    color: positionColor(position),
                    label: `${position} ${points.toFixed(0)}`,
                  }))}
              />
            </div>
          </Section>
        )}

        <Section
          title="Starters and bench, with the volume behind them"
          note="Every projection alongside the opportunity that produces it. A bench player with more opportunity than the starter ahead of him is the swap worth checking below."
        >
          <div className="panel scroll-x">
            <table className="data-table" style={{ minWidth: '44rem' }}>
              <thead>
                <tr>
                  <th style={{ width: '3.5rem' }}>Slot</th>
                  <th style={{ width: '2rem' }} />
                  <th style={{ minWidth: '10rem' }}>Player</th>
                  <th style={{ width: '8rem' }}>Projected</th>
                  <th className="text-right">±</th>
                  <th className="text-right">Opp</th>
                  <th className="text-right">Tgt%</th>
                  <th className="text-right">TD-dep</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {[...slots, ...bench].map((entry, index) => {
                  const usage = entry.playerId === null ? undefined : usageOf.get(entry.playerId);
                  const isStarter = index < slots.length;

                  return (
                    <tr key={`${entry.slot}-${entry.playerId ?? index}`} data-mine={isStarter}>
                      <td className="text-[11px] font-semibold" style={{ color: 'var(--ink-faint)' }}>
                        {entry.slot}
                      </td>
                      <td>{entry.playerId === null ? null : <PositionChip position={entry.position} />}</td>
                      <td
                        className="max-w-[13rem] truncate"
                        style={{
                          fontWeight: isStarter ? 600 : 400,
                          color: entry.playerId === null ? 'var(--bad)' : 'var(--ink)',
                        }}
                      >
                        {entry.name}
                        {entry.team !== '' && (
                          <span className="ml-1.5 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                            {entry.team}
                          </span>
                        )}
                      </td>
                      <td>
                        <CellBar
                          value={entry.projected}
                          max={maxSlotPoints}
                          width={56}
                          color={isStarter ? positionColor(entry.position) : 'var(--p-low)'}
                          label={entry.projected.toFixed(1)}
                        />
                      </td>
                      <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
                        {entry.sd === 0 ? '—' : entry.sd.toFixed(1)}
                      </td>
                      <td className="tabular text-right">
                        {usage === undefined || usage.opportunities === 0 ? '—' : usage.opportunities.toFixed(1)}
                      </td>
                      <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
                        {usage === undefined || usage.targets === 0 ? '—' : formatPct(usage.targetShare)}
                      </td>
                      <td
                        className="tabular text-right"
                        style={{ color: (usage?.tdDependence ?? 0) > 0.35 ? 'var(--warn)' : 'var(--ink-faint)' }}
                      >
                        {usage === undefined || usage.points === 0 ? '—' : formatPct(usage.tdDependence)}
                      </td>
                      <td
                        className="text-[11px]"
                        style={{ color: entry.injuryStatus === null ? 'var(--ink-faint)' : 'var(--bad)' }}
                      >
                        {entry.injuryStatus ?? (isStarter ? 'starting' : 'bench')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        {myTeamId !== null && (
          <Section
            title="Price a change"
            source="2,000 season simulations · model v1-usage+positional"
            note="Pick a starter to see who could legally take the slot and what each swap does to your title odds — including, often, that it does nothing worth thinking about."
          >
            <LineupBoard league={wire} myTeamId={myTeamId} slots={slots} bench={bench} />
          </Section>
        )}

        {matchups.length > 0 && (
          <Section
            title="What each starter is walking into"
            source="nflverse play-by-play, 2024-25 · scheme measured three times, applied zero times"
            note={
              <>
                The opposing defense&rsquo;s measured tendencies, next to the projection they bear
                on — and, first, whether the matchup can reach the call at all.{' '}
                <strong>
                  {schemeCanReach === 0
                    ? 'This week it reaches none of them.'
                    : `This week it reaches ${schemeCanReach} of ${matchups.length}.`}
                </strong>{' '}
                Every start/sit margin is compared against the largest movement scheme could
                produce without 21,679 player-weeks having detected it.{' '}
                <Link href={`/league/${leagueId}/scheme`} className="underline" style={{ color: 'var(--ink-muted)' }}>
                  See the measurement
                </Link>
              </>
            }
          >
            <StarterMatchups rows={matchups} />
          </Section>
        )}
      </RailLayout>
    </>
  );
}
