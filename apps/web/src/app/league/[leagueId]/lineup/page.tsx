import { optimalLineup, asPlayerId, type LineupCandidate, type Position } from '@ffe/core';
import { LeagueNav } from '@/components/LeagueNav';
import { LineupBoard, type LineupSlotView } from '@/components/LineupBoard';
import { StatTile } from '@/components/StatTile';
import { loadAvailability } from '@/lib/availability';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { loadArtifact, scoreFor } from '@/lib/projections';
import { serializeLeague } from '@/lib/serialize';
import { loadMarketValues } from '@/lib/values';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

export default async function LineupPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);
  const { snapshot, myTeamId } = view;

  const [artifact, availability, values, playerInfo] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadAvailability(),
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex),
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
    if (projection === undefined || !projection.active) return [];

    const position = projection.position as Position;
    const status = availability[String(id)]?.injuryStatus ?? null;

    return [
      {
        playerId: asPlayerId(String(id)),
        position,
        eligiblePositions: [position],
        projectedPoints: scoreFor(projection, rules, status),
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

  const total = slots.reduce((sum, slot) => sum + slot.projected, 0);
  const hurtStarters = slots.filter((slot) => slot.injuryStatus !== null);
  const emptySlots = slots.filter((slot) => slot.playerId === null);

  const wire = serializeLeague(view, values, playerInfo);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="lineup"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-5xl px-6 pb-20">
        <section className="mb-8">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded border sm:grid-cols-4"
            style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}>
            <StatTile label={`Week ${snapshot.asOfWeek} projection`} value={total.toFixed(1)} sub="starting lineup" />
            <StatTile
              label="Starters with a flag"
              value={String(hurtStarters.length)}
              sub={hurtStarters.length === 0 ? 'all clear' : hurtStarters.map((s) => s.name).join(', ')}
              emphasis={hurtStarters.length > 0}
            />
            <StatTile label="Bench" value={String(bench.length)} sub="eligible alternatives" />
            <StatTile
              label="Empty slots"
              value={String(emptySlots.length)}
              sub={emptySlots.length === 0 ? 'lineup full' : emptySlots.map((s) => s.slot).join(', ')}
              emphasis={emptySlots.length > 0}
            />
          </div>

          <p className="mt-3 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
            The lineup is solved rather than sorted — in superflex that means starting two
            quarterbacks when the arithmetic says so, which greedy ordering gets wrong. Injured
            players are discounted by their chance of playing, and ruled-out players cannot be
            started at all.
          </p>
        </section>

        {myTeamId !== null && (
          <LineupBoard league={wire} myTeamId={myTeamId} slots={slots} bench={bench} />
        )}
      </main>
    </>
  );
}
