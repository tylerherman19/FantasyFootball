import { modelPickValues, pickInventory, valuePicks } from '@ffe/core';
import { derived, type LeagueView } from './league-data';
import type { WirePick } from './serialize';
import { loadMarketData } from './values';

/**
 * Tradeable draft picks for one league.
 *
 * Only dynasty and keeper leagues have them as assets — in redraft the next
 * draft wipes the slate, so a "2027 first" is not a thing anyone trades.
 *
 * Each pick is priced against the projected finish of the team that will
 * produce it, which is the entire reason a rebuilding team's first is worth
 * chasing and a contender's is not.
 *
 * What it is priced *in* changed. Slot values used to come from a published
 * pick chart carried on the market feed; they now come from our own valuation
 * of the rookie class the pick would actually be spent on. A chart says a 1.03
 * is worth the same in every draft ever held. The class says whether this one
 * has three players worth having or eleven.
 */

/** How many seasons ahead leagues actually trade. Beyond this is noise. */
const SEASONS_AHEAD = 3;
const ROUNDS = [1, 2, 3, 4];

const computePicks = async (view: LeagueView): Promise<WirePick[]> => {
  const { snapshot, result } = view;

  if (snapshot.league.format !== 'dynasty' && snapshot.league.format !== 'keeper') {
    return [];
  }

  const market = await loadMarketData(snapshot);
  // No valued rookie class means no basis for pricing a pick. Publishing zeros
  // would put "free" first-rounders into the trade finder.
  if (market.rookieValues.length === 0) return [];

  const seasons = Array.from({ length: SEASONS_AHEAD }, (_, i) => snapshot.league.season + 1 + i);
  const inventory = pickInventory(snapshot, seasons, ROUNDS);

  const valued = valuePicks(
    inventory,
    result,
    snapshot,
    modelPickValues(market.rookieValues, snapshot.league.season + 1, {
      teamCount: snapshot.league.teamCount,
    }),
  );

  return valued.map((pick) => ({
    id: `pick:${pick.season}:${pick.round}:${pick.originalTeamId}`,
    description: pick.description,
    season: pick.season,
    round: pick.round,
    ownerTeamId: pick.ownerTeamId,
    value: pick.value,
  }));
};

/**
 * Cached per league state.
 *
 * The trades page and the dynasty page both price the same inventory against
 * the same simulated finishes, and the answer cannot differ between them.
 */
export const loadPicks = derived('picks', computePicks);
