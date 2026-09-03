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
import type { WirePlayer, WireLeague } from './serialize';

/**
 * Rehydrate the league in the browser and evaluate trades against it.
 *
 * The same engine the server runs — literally the same functions — so a trade
 * graded here cannot disagree with one graded there.
 */

const toWireProjection = (player: WirePlayer): PlayerProjection => ({
  playerId: asPlayerId(player.id),
  position: player.position as Position,
  eligiblePositions: [player.position as Position],
  mean: player.mean,
  sd: player.sd,
  gameId: player.gameId,
  gameLoading: player.gameLoading,
  active: player.active,
});

/**
 * One entry per week, with each player sat down in his own bye week.
 *
 * The browser sim used to reuse a single weekly map for every remaining week,
 * which meant it played everyone all season including their byes — the same
 * class of error the server-side pool had, arriving from the other direction.
 * `active` on the wire means "on an NFL roster", so it cannot answer this;
 * `byeWeek` can.
 *
 * Built as an overlay on the shared baseline rather than a copy per week: a
 * league is a few hundred players and this runs on the user's machine, in the
 * interactive path, on every what-if.
 */
const poolAcrossWeeks = (
  baseline: ReadonlyMap<ReturnType<typeof asPlayerId>, PlayerProjection>,
  players: readonly WirePlayer[],
  weeks: readonly number[],
): Map<number, Map<ReturnType<typeof asPlayerId>, PlayerProjection>> => {
  const sittingIn = new Map<number, WirePlayer[]>();
  for (const player of players) {
    if (player.byeWeek === null || !weeks.includes(player.byeWeek)) continue;
    const existing = sittingIn.get(player.byeWeek);
    if (existing === undefined) sittingIn.set(player.byeWeek, [player]);
    else existing.push(player);
  }

  const pool = new Map<number, Map<ReturnType<typeof asPlayerId>, PlayerProjection>>();

  for (const week of weeks) {
    const sitting = sittingIn.get(week);
    if (sitting === undefined) {
      pool.set(week, baseline as Map<ReturnType<typeof asPlayerId>, PlayerProjection>);
      continue;
    }

    const forWeek = new Map(baseline);
    for (const player of sitting) {
      forWeek.set(asPlayerId(player.id), {
        ...toWireProjection(player),
        mean: 0,
        sd: 0,
        active: false,
        // Not part of his team's game, so not drawn from its outcome.
        gameId: `bye-${player.id}`,
      });
    }
    pool.set(week, forWeek);
  }

  return pool;
};

const rebuildContext = (wire: WireLeague, iterations: number): SimContext => {
  const weekly = new Map<ReturnType<typeof asPlayerId>, PlayerProjection>();

  for (const player of Object.values(wire.players)) {
    weekly.set(asPlayerId(player.id), toWireProjection(player));
  }

  const pool = poolAcrossWeeks(weekly, Object.values(wire.players), wire.weeks);

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

  const verdict =
    mine.titleDelta <= 0
      ? 'Declines your odds — pass.'
      : theirs.titleDelta > 0
        ? 'Both sides improve. The rare genuinely mutual trade.'
        : fairness > 0.25
          ? 'Helps you, but lopsided enough in value terms that they will likely refuse.'
          : 'Improves your odds at their expense — worth proposing.';

  const includesPicks = [...iSend, ...iGet].some((id) => !isPlayer(id));

  const pickNote = includesPicks
    ? " Picks move model value but play no games, so this season's odds reflect the players only."
    : '';

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
    extended.set(asPlayerId(player.id), toWireProjection(player));
  }

  // Byes apply to free agents too — adding a player whose bye lands in a week
  // you need him is exactly the mistake a waiver tool should not help you make.
  return {
    ...context,
    pool: poolAcrossWeeks(
      extended,
      [...Object.values(wire.players), ...wire.freeAgents],
      wire.weeks,
    ),
  };
};


export interface SwapVerdict {
  readonly inPlayerId: string;
  readonly outPlayerId: string;
  readonly titleDelta: number;
  readonly playoffDelta: number;
  readonly pointsDelta: number;
  /** True when the gap is inside what the projection can actually resolve. */
  readonly negligible: boolean;
  readonly explanation: string;
}

/**
 * Below this, the difference is smaller than the model's own error and the
 * honest answer is "it doesn't matter". Saying so saves a manager an hour.
 */
const NEGLIGIBLE_TITLE_DELTA = 0.0015;

/**
 * Price one start/sit decision in championship probability.
 *
 * Projected points answer "who scores more on average", which is not the same
 * question. A high-floor player is worth more when you are favoured and only
 * need to avoid disaster; a volatile one is worth more when you need variance.
 * The simulator already knows that, so the answer comes from it.
 *
 * Implemented by removing the other option, which forces the solver to seat the
 * one being tested — reusing the machinery that runs everything else rather
 * than a parallel code path that could disagree with it.
 */
export const evaluateSwapClient = (
  wire: WireLeague,
  teamId: string,
  outPlayerId: string,
  inPlayerId: string,
  iterations = 3_000,
): SwapVerdict => {
  const context = rebuildContext(wire, iterations);

  const withIn = oddsDelta(context, [{ teamId, drop: [asPlayerId(outPlayerId)] }], teamId);
  const withOut = oddsDelta(context, [{ teamId, drop: [asPlayerId(inPlayerId)] }], teamId);

  const titleDelta = withIn.after.titlePct - withOut.after.titlePct;
  const playoffDelta = withIn.after.playoffPct - withOut.after.playoffPct;

  const inPoints = wire.players[inPlayerId]?.mean ?? 0;
  const outPoints = wire.players[outPlayerId]?.mean ?? 0;
  const pointsDelta = inPoints - outPoints;

  const negligible = Math.abs(titleDelta) < NEGLIGIBLE_TITLE_DELTA;
  const inName = wire.players[inPlayerId]?.name ?? 'that player';
  const outName = wire.players[outPlayerId]?.name ?? 'the starter';

  let explanation: string;
  if (negligible) {
    explanation = "Either choice is fine — the difference is inside the model's own margin.";
  } else if (titleDelta > 0 && pointsDelta < 0) {
    // The interesting case: the lower projection is the better start.
    explanation =
      `${inName} projects ${Math.abs(pointsDelta).toFixed(1)} fewer points than ${outName} but still ` +
      'improves your title odds — the shape of the distribution fits your situation better than the average does.';
  } else if (titleDelta > 0) {
    explanation = `${inName} is the better start, by ${pointsDelta.toFixed(1)} projected points.`;
  } else {
    explanation = `Keep ${outName} — swapping costs you ${Math.abs(titleDelta * 100).toFixed(2)}% of a title.`;
  }

  return { inPlayerId, outPlayerId, titleDelta, playoffDelta, pointsDelta, negligible, explanation };
};


// ---------------------------------------------------------------------------
// Roster-level scenarios (§60)
// ---------------------------------------------------------------------------

export interface InjuryScenario {
  readonly playerId: string;
  readonly name: string;
  readonly titleBefore: number;
  readonly titleAfter: number;
  readonly playoffBefore: number;
  readonly playoffAfter: number;
  /** Percentage points of title probability lost if he misses the season. */
  readonly titleCost: number;
  /** Share of your title odds riding on this one man. */
  readonly shareOfOdds: number;
}

/**
 * What happens to your season if one player is gone.
 *
 * The what-if that already existed was player-level: move his targets, watch his
 * projection move. This is the roster-level one the brief asks for in §60 — "what
 * if the QB gets injured" — and it is a different question, because the answer
 * is not about him. It is about how much of your title probability was resting on
 * him, which is a fact about how your roster is built.
 *
 * Implemented as removal rather than as a projection haircut. A season-ending
 * injury is not "he scores less"; it is the lineup solver having to find
 * somebody else every week, and the cost is whatever the next man up cannot do.
 * Halving his projection would understate it precisely when the bench is thin,
 * which is exactly when a manager needs to know.
 *
 * Seeded and deterministic, so the same roster gives the same answer twice.
 */
export const injuryScenarios = (
  wire: WireLeague,
  myTeamId: string,
  playerIds: readonly string[],
  iterations = 1_500,
): InjuryScenario[] => {
  const base = rebuildContext(wire, iterations);
  const before = currentOdds(base, myTeamId);

  return playerIds
    .flatMap((playerId): InjuryScenario[] => {
      const player = wire.players[playerId];
      if (player === undefined) return [];

      // Remove him from the roster entirely and re-simulate.
      const context: SimContext = {
        ...base,
        teams: base.teams.map((team) =>
          team.teamId === myTeamId
            ? { ...team, playerIds: team.playerIds.filter((id) => String(id) !== playerId) }
            : team,
        ),
      };

      const after = currentOdds(context, myTeamId);
      const titleCost = before.titlePct - after.titlePct;

      return [
        {
          playerId,
          name: player.name,
          titleBefore: before.titlePct,
          titleAfter: after.titlePct,
          playoffBefore: before.playoffPct,
          playoffAfter: after.playoffPct,
          titleCost,
          shareOfOdds: before.titlePct > 0 ? titleCost / before.titlePct : 0,
        },
      ];
    })
    .sort((a, b) => b.titleCost - a.titleCost);
};
