import { SLOT_ELIGIBILITY, isStartingSlot, type LineupSlot, type PlayerId, type Position } from '../domain/index.js';
import { optimalLineup } from '../sim/lineup.js';

/**
 * Positional scarcity, measured against *this* league's replacement level.
 *
 * "He's the RB14" means nothing without knowing how many running backs start in
 * your league. A 12-team league starting 2RB+FLEX exhausts useful running backs
 * somewhere around RB30; a 10-team league starting 1RB does not. Generic tiers
 * and generic VORP charts are computed for a league nobody is actually in.
 *
 * So replacement level is derived from the league object itself: how many teams,
 * which slots, and — the part most implementations skip — how flex slots
 * actually get filled. A FLEX is not a third of an RB, a third of a WR and a
 * third of a TE. It is filled by whoever is best available, so flex demand
 * follows the talent and lands unevenly. We resolve that by seating the league's
 * flex slots greedily against the real player pool, so the split reflects the
 * players who exist rather than a fixed assumption.
 *
 * The number that comes out — points above replacement — is what makes a QB and
 * a WR comparable at all, and it is the input to every "is my roster actually
 * good" question on the team page.
 */

export interface ScarcityPlayer {
  readonly playerId: PlayerId;
  readonly position: Position;
  /** Positions the player qualifies at, for flex seating. */
  readonly eligiblePositions: readonly Position[];
  /** Rest-of-season or weekly projection — whichever the caller is ranking on. */
  readonly points: number;
}

export interface ReplacementLevel {
  readonly position: Position;
  /** Points scored by the first player past the last startable one. */
  readonly points: number;
  /** How many of this position the league starts in total, flex included. */
  readonly startersLeagueWide: number;
  /**
   * True when the pool ran out before demand was met, so the level is the worst
   * known player rather than a real replacement. Treat the VORP as a floor.
   */
  readonly extrapolated: boolean;
}

/** Dedicated (non-flex) starting slots per position, for one team. */
const dedicatedSlots = (rosterSlots: readonly LineupSlot[]): Map<Position, number> => {
  const counts = new Map<Position, number>();

  for (const slot of rosterSlots) {
    const eligible = SLOT_ELIGIBILITY[slot];
    if (eligible === null || eligible.length !== 1) continue;
    const position = eligible[0]!;
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }

  return counts;
};

/** Flex slots for one team, as the set of positions each one accepts. */
const flexSlots = (rosterSlots: readonly LineupSlot[]): (readonly Position[])[] =>
  rosterSlots
    .filter((slot) => isStartingSlot(slot))
    .map((slot) => SLOT_ELIGIBILITY[slot])
    .filter((eligible): eligible is readonly Position[] => eligible !== null && eligible.length > 1);

/**
 * League-wide demand per position, resolving flex slots against the real pool.
 *
 * Dedicated slots are counted first. Then every flex slot in the league is
 * seated one at a time, each going to whichever eligible position currently
 * offers the best unclaimed player. That is what managers do, and it puts flex
 * demand where the talent actually is instead of splitting it by assumption.
 */
const positionDemand = (
  rosterSlots: readonly LineupSlot[],
  teamCount: number,
  ranked: ReadonlyMap<Position, readonly ScarcityPlayer[]>,
): Map<Position, number> => {
  const demand = new Map<Position, number>();

  for (const [position, perTeam] of dedicatedSlots(rosterSlots)) {
    demand.set(position, perTeam * teamCount);
  }

  const flexes = flexSlots(rosterSlots);

  for (let seat = 0; seat < flexes.length * teamCount; seat += 1) {
    const eligible = flexes[Math.floor(seat / teamCount)]!;

    let bestPosition: Position | null = null;
    let bestPoints = Number.NEGATIVE_INFINITY;

    for (const position of eligible) {
      const pool = ranked.get(position) ?? [];
      const next = pool[demand.get(position) ?? 0];
      if (next !== undefined && next.points > bestPoints) {
        bestPoints = next.points;
        bestPosition = position;
      }
    }

    // Every eligible position is exhausted; the remaining flex seats cannot be
    // filled from a pool this small, and inventing demand would move the
    // replacement level for no reason.
    if (bestPosition === null) break;

    demand.set(bestPosition, (demand.get(bestPosition) ?? 0) + 1);
  }

  return demand;
};

const rankByPosition = (
  players: readonly ScarcityPlayer[],
): Map<Position, ScarcityPlayer[]> => {
  const byPosition = new Map<Position, ScarcityPlayer[]>();

  for (const player of players) {
    // A flex-eligible player is ranked at every position he can fill, so a
    // TE/WR shows up in both pools when the league lets him start at either.
    //
    // League-wide this slightly overstates supply, since one man cannot fill two
    // seats. It is left alone deliberately: multi-position players are a thin
    // slice of the pool, they sit near the top of it where demand is already
    // met, and the alternative — solving the league's entire lineup jointly to
    // set a replacement level — costs far more than the correction is worth.
    // `teamScarcity` does resolve it exactly, because there it changes answers.
    const positions = new Set<Position>([player.position, ...player.eligiblePositions]);
    for (const position of positions) {
      const pool = byPosition.get(position) ?? [];
      pool.push(player);
      byPosition.set(position, pool);
    }
  }

  for (const pool of byPosition.values()) {
    pool.sort((a, b) => b.points - a.points);
  }

  return byPosition;
};

export const replacementLevels = (
  players: readonly ScarcityPlayer[],
  rosterSlots: readonly LineupSlot[],
  teamCount: number,
): Map<Position, ReplacementLevel> => {
  const ranked = rankByPosition(players);
  const demand = positionDemand(rosterSlots, teamCount, ranked);

  const out = new Map<Position, ReplacementLevel>();

  for (const [position, starters] of demand) {
    const pool = ranked.get(position) ?? [];

    // The replacement is the best player *not* starting anywhere — the guy on
    // the waiver wire you'd pick up if you lost a starter.
    const replacement = pool[starters];

    out.set(position, {
      position,
      points: replacement?.points ?? pool[pool.length - 1]?.points ?? 0,
      startersLeagueWide: starters,
      extrapolated: replacement === undefined,
    });
  }

  return out;
};

export interface TeamScarcity {
  readonly teamId: string;
  /** Points above replacement, per position, from this team's startable players. */
  readonly byPosition: ReadonlyMap<Position, number>;
  readonly total: number;
}

/**
 * A team's value above replacement, position by position.
 *
 * Only the players who would actually start count toward a position's total —
 * a fourth quality running back on a 2RB roster is trade bait, not strength, and
 * counting him as strength is how tools talk teams out of good trades.
 *
 * Who starts is decided by the same solver the simulator uses, rather than by
 * taking the top N at each position. That matters for two reasons: flex slots
 * are real starting jobs and belong in the total, and a multi-position player
 * can only fill one of them — ranking him separately at each position he
 * qualifies for would count the same man twice.
 */
export const teamScarcity = (
  teamId: string,
  roster: readonly ScarcityPlayer[],
  levels: ReadonlyMap<Position, ReplacementLevel>,
  rosterSlots: readonly LineupSlot[],
): TeamScarcity => {
  const lineup = optimalLineup(
    roster.map((player) => ({
      playerId: player.playerId,
      position: player.position,
      eligiblePositions: player.eligiblePositions,
      projectedPoints: player.points,
      stddev: 0,
    })),
    rosterSlots,
  );

  const byPosition = new Map<Position, number>();

  for (const slot of lineup.slots) {
    if (slot.playerId === null || slot.position === null) continue;

    // A flex starter is credited against his own position's replacement level:
    // the question is what this roster spot is worth over the alternative, and
    // the alternative is a replacement player at the position he plays.
    const level = levels.get(slot.position);
    if (level === undefined) continue;

    const above = slot.projectedPoints - level.points;
    byPosition.set(slot.position, (byPosition.get(slot.position) ?? 0) + above);
  }

  return {
    teamId,
    byPosition,
    total: [...byPosition.values()].reduce((sum, v) => sum + v, 0),
  };
};
