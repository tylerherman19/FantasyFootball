import { SLOT_ELIGIBILITY, type LineupSlot, type Position } from '../domain/index.js';

/**
 * Asset value, computed here rather than bought.
 *
 * Every price on this site used to come from `api.fantasycalc.com`. That was a
 * defensible starting point — those numbers are real trades from real leagues,
 * which is a genuine market and not one analyst's opinion — but it meant the
 * product's central currency was a number it could neither explain nor stand
 * behind. When the site said a trade was unfair it was reporting somebody
 * else's conclusion, and when the market was wrong the site was wrong with it,
 * silently, with no way to disagree.
 *
 * It also could not answer for the league in front of it. A single public feed
 * is parameterised by team count, superflex and a PPR number, and that is the
 * whole of its league awareness. It does not know this league starts three
 * receivers and a tight end, that it plays two flexes, that it awards a point
 * per first down, or that eleven weeks remain. Those are exactly the facts that
 * decide what a player is worth.
 *
 * So value is derived from what the model already believes:
 *
 *     value = discounted surplus over replacement, across the horizon
 *
 * Three ideas, none of them novel and all of them checkable:
 *
 * 1. **Replacement, not zero.** A running back is worth what he produces above
 *    the back you could have started instead, which is the last one who gets
 *    started anywhere in the league. Points above zero would price a bench body
 *    at half a starter; points above replacement prices him near nothing, which
 *    is what he is.
 *
 * 2. **Replacement comes from the lineup, not a convention.** How many backs
 *    start league-wide depends on the slots, the flexes and the team count. A
 *    superflex league starts roughly twice the quarterbacks, which is why
 *    quarterbacks reprice there — and this falls out of counting slots rather
 *    than being asserted as a special case.
 *
 * 3. **Horizon separates dynasty from redraft.** Redraft values the games that
 *    remain. Dynasty values those plus the seasons after them, aged along the
 *    fitted curves and discounted. Same arithmetic, different horizon, which is
 *    why one function answers both instead of two that can disagree.
 *
 * The unit is deliberately the familiar 0-10,000 index rather than raw points,
 * so the numbers stay legible next to the ones managers already carry in their
 * heads. What changed is that every one of them is now traceable to a
 * projection this repository produced and a replacement level it can show you.
 */

/** One player, as the valuation model needs him. */
export interface ValuationInput {
  readonly playerId: string;
  readonly name: string;
  readonly position: Position;
  /**
   * Projected points per game under *this league's* scoring, healthy.
   *
   * Not season totals: byes and injuries vary the games played and would leak
   * schedule into a quantity meant to measure the player.
   */
  readonly pointsPerGame: number;
  /**
   * Production in each future season as a share of this one, from the fitted
   * age curves. Index 0 is next season. Empty for a redraft valuation, and for
   * a player whose curve does not reach that far.
   */
  readonly futureSeasons?: readonly number[];
  /** True when the projection is a draft-capital prior rather than observed play. */
  readonly rookie?: boolean;
}

export interface ValuationSettings {
  readonly teamCount: number;
  readonly rosterSlots: readonly LineupSlot[];
  /** Games left in the current season, including this week. */
  readonly gamesRemaining: number;
  /** True for dynasty and keeper: seasons beyond this one carry value. */
  readonly multiYear: boolean;
  /** Per-season discount. Sooner is worth more, and rosters churn. */
  readonly discount?: number;
}

export interface AssetValue {
  readonly playerId: string;
  readonly name: string;
  readonly position: Position;
  /** The published index, 0-10,000. */
  readonly value: number;
  readonly overallRank: number;
  readonly positionRank: number;
  /** Points per game above this position's replacement level. */
  readonly pointsAboveReplacement: number;
  /** The replacement level he was measured against, per game. */
  readonly replacementLevel: number;
  /** Share of the value that comes from seasons after this one. */
  readonly futureShare: number;
}

export interface ReplacementLevel {
  readonly position: Position;
  /** How many at this position start league-wide, dedicated slots plus flex. */
  readonly startersLeagueWide: number;
  /** Points per game of the first player who does not start. */
  readonly pointsPerGame: number;
}

const FLEXES: readonly LineupSlot[] = ['FLEX', 'WRRB_FLEX', 'REC_FLEX', 'SUPER_FLEX', 'IDP_FLEX'];

const DEFAULT_DISCOUNT = 0.88;

/**
 * How many players at each position actually start, league-wide.
 *
 * Dedicated slots are a multiplication. Flexes are not: a flex is filled by
 * whoever is best among the positions it accepts, so its demand belongs to a
 * position only after the fact. Assigning them by convention — "a flex is
 * usually a running back" — is where positional value models normally go wrong,
 * because it bakes in the answer for a league that may not play that way.
 *
 * So the flexes are filled the way a manager fills them: pool everyone still
 * eligible, take the best, and see where they came from. In a league where
 * receivers are deep the flexes fill with receivers and the receiver
 * replacement level drops accordingly, which is the correct and self-correcting
 * behaviour.
 */
export const replacementLevels = (
  players: readonly ValuationInput[],
  settings: ValuationSettings,
): Map<Position, ReplacementLevel> => {
  const teams = Math.max(1, Math.round(settings.teamCount));

  const byPosition = new Map<Position, ValuationInput[]>();
  for (const player of players) {
    const bucket = byPosition.get(player.position);
    if (bucket === undefined) byPosition.set(player.position, [player]);
    else bucket.push(player);
  }
  for (const bucket of byPosition.values()) {
    bucket.sort((a, b) => b.pointsPerGame - a.pointsPerGame);
  }

  // Dedicated demand first.
  const demand = new Map<Position, number>();
  for (const slot of settings.rosterSlots) {
    const eligible = SLOT_ELIGIBILITY[slot];
    if (eligible === null || eligible.length !== 1) continue;
    const position = eligible[0]!;
    demand.set(position, (demand.get(position) ?? 0) + teams);
  }

  // Then the flexes, allocated by who is actually left.
  //
  // Cursors track how far into each position the dedicated slots already
  // reached, so a flex competes against the *next* man at each position rather
  // than against players who are already starting somewhere.
  const cursor = new Map<Position, number>();
  for (const [position, count] of demand) cursor.set(position, count);

  for (const slot of settings.rosterSlots) {
    if (!FLEXES.includes(slot)) continue;
    const eligible = SLOT_ELIGIBILITY[slot];
    if (eligible === null) continue;

    for (let team = 0; team < teams; team += 1) {
      let bestPosition: Position | null = null;
      let bestPoints = -Infinity;

      for (const position of eligible) {
        const bucket = byPosition.get(position);
        if (bucket === undefined) continue;
        const next = bucket[cursor.get(position) ?? 0];
        if (next === undefined) continue;
        if (next.pointsPerGame > bestPoints) {
          bestPoints = next.pointsPerGame;
          bestPosition = position;
        }
      }

      if (bestPosition === null) break;
      cursor.set(bestPosition, (cursor.get(bestPosition) ?? 0) + 1);
      demand.set(bestPosition, (demand.get(bestPosition) ?? 0) + 1);
    }
  }

  const levels = new Map<Position, ReplacementLevel>();

  for (const [position, bucket] of byPosition) {
    const starters = demand.get(position) ?? 0;

    // Averaged over a small band rather than read off one player. The single
    // player at the boundary is one projection, and one projection is noise;
    // the band is the same idea with the jitter taken out, so a league's
    // replacement level does not lurch because one back moved two ranks.
    const band = bucket.slice(starters, starters + 3).map((p) => p.pointsPerGame);
    const level =
      band.length > 0
        ? band.reduce((sum, points) => sum + points, 0) / band.length
        : (bucket[bucket.length - 1]?.pointsPerGame ?? 0);

    levels.set(position, {
      position,
      startersLeagueWide: starters,
      // A position nobody starts has no replacement level worth speaking of;
      // reporting one would price its bench against a fiction.
      pointsPerGame: starters === 0 ? Number.POSITIVE_INFINITY : Math.max(0, level),
    });
  }

  return levels;
};

/**
 * Surplus over replacement, across the horizon, as an index.
 *
 * The discount does two jobs at once and it is worth naming both. Money-style
 * impatience is the smaller one. The larger is that a projection three seasons
 * out is a projection of a roster spot, not of a player: he may be traded, cut,
 * hurt, or simply wrong about. Compounding 0.88 says the fourth season is worth
 * about two-thirds of the first, which is roughly how dynasty managers behave
 * and considerably less patient than a pure production model would be.
 */
export const valueAssets = (
  players: readonly ValuationInput[],
  settings: ValuationSettings,
): AssetValue[] => {
  const levels = replacementLevels(players, settings);
  const discount = settings.discount ?? DEFAULT_DISCOUNT;
  const games = Math.max(0, settings.gamesRemaining);

  const raw = players.map((player) => {
    const level = levels.get(player.position)?.pointsPerGame ?? 0;
    const perGame = player.pointsPerGame - level;

    // This season: only the games that are left.
    let surplus = Math.max(0, perGame) * games;
    let future = 0;

    if (settings.multiYear) {
      const seasons = player.futureSeasons ?? [];
      for (let index = 0; index < seasons.length; index += 1) {
        const share = seasons[index]!;
        // Replacement level is held flat across the horizon. It moves far less
        // than any individual player does — the league always starts the same
        // number of backs — and pretending to forecast it would add a guess to
        // every player's price for no gain in ordering.
        const seasonSurplus = Math.max(0, player.pointsPerGame * share - level) * 17;
        future += seasonSurplus * discount ** (index + 1);
      }
      surplus += future;
    }

    return { player, surplus, future, level };
  });

  // The index is anchored to the best asset in *this* league, which keeps it
  // comparable to the numbers managers already use without pretending to a
  // precision the underlying points do not have.
  const top = raw.reduce((best, entry) => Math.max(best, entry.surplus), 0);
  const scale = top > 0 ? 10_000 / top : 0;

  const valued = raw
    .map((entry) => ({
      playerId: entry.player.playerId,
      name: entry.player.name,
      position: entry.player.position,
      value: Math.round(entry.surplus * scale),
      overallRank: 0,
      positionRank: 0,
      pointsAboveReplacement: entry.player.pointsPerGame - entry.level,
      replacementLevel: Number.isFinite(entry.level) ? entry.level : 0,
      futureShare: entry.surplus > 0 ? entry.future / entry.surplus : 0,
    }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  const positionCounts = new Map<Position, number>();

  return valued.map((entry, index) => {
    const positionRank = (positionCounts.get(entry.position) ?? 0) + 1;
    positionCounts.set(entry.position, positionRank);
    return { ...entry, overallRank: index + 1, positionRank };
  });
};
