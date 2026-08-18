import { marketPickValues, pickInventory, valuePicks } from '@ffe/core';
import type { LeagueView } from './league-data';
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
 */

/** How many seasons ahead leagues actually trade. Beyond this is noise. */
const SEASONS_AHEAD = 3;
const ROUNDS = [1, 2, 3, 4];

export const loadPicks = async (view: LeagueView): Promise<WirePick[]> => {
  const { snapshot, result } = view;

  if (snapshot.league.format !== 'dynasty' && snapshot.league.format !== 'keeper') {
    return [];
  }

  const market = await loadMarketData(snapshot.league.format, snapshot.league.superFlex);
  if (market.picks.size === 0) return [];

  const seasons = Array.from({ length: SEASONS_AHEAD }, (_, i) => snapshot.league.season + 1 + i);
  const inventory = pickInventory(snapshot, seasons, ROUNDS);

  const valued = valuePicks(
    inventory,
    result,
    snapshot,
    marketPickValues(market.picks, snapshot.league.season + 1),
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
