import { edgePickValues, pickInventory, valuePicks } from '@ffe/core';
import type { LeagueView } from './league-data';
import type { WirePick } from './serialize';
import { loadEdgeValues } from './edge-values';

/**
 * Tradeable draft picks for one league.
 *
 * Only dynasty and keeper leagues have them as assets — in redraft the next
 * draft wipes the slate, so a "2027 first" is not a thing anyone trades.
 *
 * Each pick is priced against the projected finish of the team that will
 * produce it, which is the entire reason a rebuilding team's first is worth
 * chasing and a contender's is not. The slot values themselves come from the
 * model's own rookie class (edgePickChart), not a market feed.
 */

/** How many seasons ahead leagues actually trade. Beyond this is noise. */
const SEASONS_AHEAD = 3;
const ROUNDS = [1, 2, 3, 4];

export const loadPicks = async (view: LeagueView): Promise<WirePick[]> => {
  const { snapshot, result } = view;

  if (snapshot.league.format !== 'dynasty' && snapshot.league.format !== 'keeper') {
    return [];
  }

  const { pickChart } = await loadEdgeValues(snapshot.league, snapshot.league.season, snapshot.asOfWeek);
  // No chart means the rookie class is too thin to price slots — an honest
  // "we don't know", not a missing feed.
  if (pickChart === null) return [];

  const seasons = Array.from({ length: SEASONS_AHEAD }, (_, i) => snapshot.league.season + 1 + i);
  const inventory = pickInventory(snapshot, seasons, ROUNDS);

  const valued = valuePicks(
    inventory,
    result,
    snapshot,
    edgePickValues(pickChart, snapshot.league.teamCount),
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
