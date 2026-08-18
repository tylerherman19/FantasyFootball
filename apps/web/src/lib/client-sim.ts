import {
  asPlayerId,
  currentOdds,
  estimateFutureGain,
  oddsDelta,
  fairnessGap,
  suggestBid,
  type LeagueSnapshot,
  type PlayerProjection,
  type Position,
  type SimContext,
  type TeamContext,
} from '@ffe/core';
import type { WireLeague } from './serialize';

/**
 * Rehydrate the league in the browser and evaluate trades against it.
 *
 * The same engine the server runs — literally the same functions — so a trade
 * graded here cannot disagree with one graded there.
 */

const rebuildContext = (wire: WireLeague, iterations: number): SimContext => {
  const weekly = new Map<ReturnType<typeof asPlayerId>, PlayerProjection>();

  for (const player of Object.values(wire.players)) {
    weekly.set(asPlayerId(player.id), {
      playerId: asPlayerId(player.id),
      position: player.position as Position,
      eligiblePositions: [player.position as Position],
      mean: player.mean,
      sd: player.sd,
      gameId: player.gameId,
      gameLoading: player.gameLoading,
      active: player.active,
    });
  }

  const pool = new Map(wire.weeks.map((week) => [week, weekly]));

  const teams: TeamContext[] = wire.teams.map((team) => ({
    teamId: team.teamId,
    playerIds: team.playerIds.map(asPlayerId),
    rosterSlots: wire.rosterSlots as never,
    lineupEfficiency: team.lineupEfficiency,
  }));

  const snapshot = {
    league: {
      id: wire.leagueId,
      platform: 'sleeper',
      platformLeagueId: wire.leagueId,
      name: wire.name,
      season: 0,
      format: wire.format,
      teamCount: wire.teams.length,
      rosterSlots: wire.rosterSlots,
      scoring: {
        rec: 0, passYd: 0, passTd: 0, passInt: 0, rushYd: 0,
        rushTd: 0, recYd: 0, recTd: 0, fumbleLost: 0, extra: {}, raw: {},
      },
      playoffTeams: wire.playoffTeams,
      playoffStartWeek: wire.regularSeasonWeeks + 1,
      regularSeasonWeeks: wire.regularSeasonWeeks,
      medianWins: wire.medianWins,
      superFlex: wire.rosterSlots.includes('SUPER_FLEX'),
      waiverType: 'priority',
      waiverBudget: 0,
    },
    asOfWeek: wire.asOfWeek,
    managers: wire.teams.map((t) => ({
      id: t.teamId,
      displayName: t.name,
      teamName: t.name,
      platformUserId: null,
      coOwnerUserIds: [],
    })),
    rosters: wire.teams.map((t) => ({
      teamId: t.teamId,
      managerId: t.teamId,
      playerIds: t.playerIds.map(asPlayerId),
      starterIds: [],
      taxiIds: [],
      irIds: [],
    })),
    records: wire.records.map((r) => ({ ...r, pointsAgainst: 0 })),
    schedule: wire.schedule.map((m) => ({
      ...m,
      points: [null, null] as [number | null, number | null],
      playerPoints: {},
    })),
    weeklyScores: [],
    transactions: [],
    draftPicks: [],
  } as unknown as LeagueSnapshot;

  return { snapshot, teams, pool, weeks: wire.weeks, iterations, seed: wire.seed };
};

export interface TradeGrade {
  /** True when picks were involved, so the odds figure needs context. */
  readonly includesPicks: boolean;
  readonly myTitleDelta: number;
  readonly myPlayoffDelta: number;
  readonly theirTitleDelta: number;
  readonly theirPlayoffDelta: number;
  readonly myValueDelta: number;
  readonly fairness: number;
  readonly grade: string;
  readonly verdict: string;
  readonly acceptable: boolean;
}

/**
 * A letter grade, from the odds change rather than from value points.
 *
 * Value-based graders call a trade "even" when it does nothing for your season.
 * The grade here answers the only question that matters — how much more likely
 * are you to win the league — while fairness answers separately whether the
 * other manager would ever say yes.
 */
const gradeFor = (titleDelta: number): string => {
  if (titleDelta >= 0.04) return 'A+';
  if (titleDelta >= 0.025) return 'A';
  if (titleDelta >= 0.015) return 'B+';
  if (titleDelta >= 0.007) return 'B';
  if (titleDelta >= 0.002) return 'C+';
  if (titleDelta > -0.002) return 'C';
  if (titleDelta > -0.01) return 'D';
  return 'F';
};

export const evaluateTradeClient = (
  wire: WireLeague,
  myTeamId: string,
  partnerTeamId: string,
  iSend: readonly string[],
  iGet: readonly string[],
  iterations = 2_000,
): TradeGrade => {
  const context = rebuildContext(wire, iterations);

  // Only players enter the simulation; picks have no week-to-week effect.
  const isPlayer = (id: string) => wire.players[id] !== undefined;
  const sendPlayers = iSend.filter(isPlayer).map(asPlayerId);
  const getPlayers = iGet.filter(isPlayer).map(asPlayerId);

  const changes = [
    { teamId: myTeamId, add: getPlayers, drop: sendPlayers },
    { teamId: partnerTeamId, add: sendPlayers, drop: getPlayers },
  ];

  const mine = oddsDelta(context, changes, myTeamId);
  const theirs = oddsDelta(context, changes, partnerTeamId);

  // Picks are priced by the market but play no games, so they move value
  // without moving this season's odds. Saying that plainly is more useful than
  // pretending a 2028 second changes your playoff chances in October.
  const pickValue = new Map(wire.picks.map((pick) => [pick.id, pick.value]));
  const valueOf = (id: string) => wire.players[id]?.value ?? pickValue.get(id) ?? 0;

  const sendValue = iSend.reduce((sum, id) => sum + valueOf(id), 0);
  const getValue = iGet.reduce((sum, id) => sum + valueOf(id), 0);
  const fairness = fairnessGap(sendValue, getValue);

  const acceptable = fairness <= 0.2 || theirs.titleDelta > 0;

  const pickNote = includesPicks
    ? ' Picks move market value but play no games, so this season\'s odds reflect the players only.'
    : '';

  const verdict =
    mine.titleDelta <= 0
      ? 'Declines your odds — pass.'
      : theirs.titleDelta > 0
        ? 'Both sides improve. The rare genuinely mutual trade.'
        : fairness > 0.25
          ? 'Helps you, but lopsided enough in market terms that they will likely refuse.'
          : 'Improves your odds at their expense — worth proposing.';

  const includesPicks = [...iSend, ...iGet].some((id) => !isPlayer(id));

  return {
    includesPicks,
    myTitleDelta: mine.titleDelta,
    myPlayoffDelta: mine.playoffDelta,
    theirTitleDelta: theirs.titleDelta,
    theirPlayoffDelta: theirs.playoffDelta,
    myValueDelta: getValue - sendValue,
    fairness,
    grade: gradeFor(mine.titleDelta),
    verdict: verdict + pickNote,
    acceptable,
  };
};


export interface WaiverResult {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly projected: number;
  readonly titleDelta: number;
  readonly playoffDelta: number;
  readonly dropPlayerId: string | null;
  readonly dropName: string | null;
  readonly suggestedBid: number;
}

/**
 * Rank the wire against one roster, in the browser.
 *
 * Server-side this took twelve seconds, because it is dozens of simulations and
 * the answer changes whenever a roster does. Run here it costs nothing the user
 * waits on, and — more usefully — the drop choice becomes interactive: a manager
 * can see what each claim is worth paired with each cut rather than accepting
 * ours.
 */
export const rankWaiversClient = (
  wire: WireLeague,
  myTeamId: string,
  dropCandidateIds: readonly string[],
  iterations = 800,
): WaiverResult[] => {
  const context = rebuildContextWithFreeAgents(wire, iterations);
  const before = currentOdds(context, myTeamId);

  const results: WaiverResult[] = [];

  for (const candidate of wire.freeAgents) {
    let best: { delta: ReturnType<typeof oddsDelta>; dropId: string | null } | null = null;

    const dropOptions: (string | null)[] = dropCandidateIds.length > 0 ? [...dropCandidateIds] : [null];

    for (const dropId of dropOptions) {
      const delta = oddsDelta(
        context,
        [
          {
            teamId: myTeamId,
            add: [asPlayerId(candidate.id)],
            ...(dropId !== null ? { drop: [asPlayerId(dropId)] } : {}),
          },
        ],
        myTeamId,
        before,
      );

      if (best === null || delta.titleDelta > best.delta.titleDelta) {
        best = { delta, dropId };
      }
    }

    if (best === null) continue;

    results.push({
      playerId: candidate.id,
      name: candidate.name,
      position: candidate.position,
      team: candidate.team,
      projected: candidate.mean,
      titleDelta: best.delta.titleDelta,
      playoffDelta: best.delta.playoffDelta,
      dropPlayerId: best.dropId,
      dropName: best.dropId === null ? null : (wire.players[best.dropId]?.name ?? null),
      suggestedBid: 0,
    });
  }

  const sorted = results.sort((a, b) => b.titleDelta - a.titleDelta);

  if (wire.waiverType !== 'faab' || wire.remainingBudget <= 0) return sorted;

  // Price bids off the whole observed field, so a thin list of positives does
  // not make the wire look barren and inflate every bid.
  const futureGain = estimateFutureGain(
    sorted.map((r) => r.titleDelta),
    wire.weeksRemaining,
  );

  return sorted.map((result) => ({
    ...result,
    suggestedBid: suggestBid(result.titleDelta, wire.remainingBudget, futureGain).bid,
  }));
};

/** Same rehydration, with free agents added to the projection pool. */
const rebuildContextWithFreeAgents = (wire: WireLeague, iterations: number): SimContext => {
  const context = rebuildContext(wire, iterations);
  const weekly = context.pool.get(wire.weeks[0] ?? wire.asOfWeek);
  if (weekly === undefined) return context;

  const extended = new Map(weekly);
  for (const player of wire.freeAgents) {
    extended.set(asPlayerId(player.id), {
      playerId: asPlayerId(player.id),
      position: player.position as Position,
      eligiblePositions: [player.position as Position],
      mean: player.mean,
      sd: player.sd,
      gameId: player.gameId,
      gameLoading: player.gameLoading,
      active: player.active,
    });
  }

  return { ...context, pool: new Map(wire.weeks.map((week) => [week, extended])) };
};
