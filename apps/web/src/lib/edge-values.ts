import {
  edgePickChart,
  edgeValues,
  starterDemand,
  type EdgePickChart,
  type EdgeValuation,
} from '@ffe/core';
import type { League } from '@ffe/core';
import { loadAgeCurves } from './age-curves';
import { loadIdentities } from './crosswalk';
import { loadArtifact, scoreFor } from './projections';

/**
 * The model's own player prices, loaded for one league.
 *
 * This is the internal replacement for FantasyCalc (lib/values.ts, which now
 * exists only as an optional sanity comparison). Where the market feed priced
 * players by what other managers pay, this prices them by what the model
 * expects them to produce above a freely available replacement, in this
 * league's own scoring — the same projections and measured age curves the rest
 * of the product runs on. Nothing in a decision path depends on an external
 * API any more: if every third-party feed died tonight, trades, waivers,
 * dynasty and pick prices would all still compute.
 *
 * The currency and its consequences are documented in
 * packages/core/src/valuation/edge-value.ts; this file is the loading half.
 */

export interface EdgeValueTable {
  /** Every priced player, keyed by Sleeper id. Zero = replacement level, not missing. */
  readonly players: ReadonlyMap<string, EdgeValuation>;
  /** The model's own draft-pick chart, when the rookie class supports one. */
  readonly pickChart: EdgePickChart | null;
  /** Replacement level per position, in weekly points — shown, not hidden. */
  readonly replacement: Readonly<Record<string, number>>;
}

const cache = new Map<string, Promise<EdgeValueTable>>();

const ageFrom = (birthdate: string | null): number | undefined => {
  if (birthdate === null) return undefined;
  const years = (Date.now() - new Date(birthdate).getTime()) / (365.25 * 24 * 3600 * 1000);
  return Number.isFinite(years) && years > 0 && years < 60 ? years : undefined;
};

export const loadEdgeValues = async (
  league: League,
  season: number,
  asOfWeek: number,
): Promise<EdgeValueTable> => {
  const key = `${league.id}:${league.scoring.rec}:${season}:${asOfWeek}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const pending = (async (): Promise<EdgeValueTable> => {
    const [artifact, identities, ageCurves] = await Promise.all([
      loadArtifact(season, asOfWeek),
      loadIdentities(),
      loadAgeCurves().catch(() => null),
    ]);
    if (artifact === null) return { players: new Map(), pickChart: null, replacement: {} };

    const dynasty = league.format === 'dynasty' || league.format === 'keeper';
    const weeksRemaining = Math.max(1, league.regularSeasonWeeks - asOfWeek + 1);

    const players = Object.values(artifact.players).flatMap((player) => {
      // A player no NFL team carries is not buyable production; his projection
      // is an artifact of history, not an asset. Excluded rather than zeroed —
      // zero means "freely available", which is a different statement.
      if (!player.active) return [];
      const byeAhead = player.byeWeek !== null && player.byeWeek >= asOfWeek ? 1 : 0;
      const identity = identities[player.playerId];
      return [
        {
          playerId: player.playerId as EdgeValuation['playerId'],
          position: player.position as EdgeValuation['position'],
          weeklyPoints: scoreFor(player, league.scoring.raw),
          gamesRemaining: Math.max(0, weeksRemaining - byeAhead),
          ...(identity?.birthdate ? { age: ageFrom(identity.birthdate) } : {}),
          ...(identity?.draftOverall != null ? { draftOverall: identity.draftOverall } : {}),
          ...(player.basis === undefined ? {} : { basis: player.basis }),
        },
      ];
    });

    const demand = starterDemand(league.rosterSlots, league.teamCount);
    const valued = edgeValues(players, {
      dynasty,
      startersByPosition: demand,
      teamCount: league.teamCount,
      gamesPerSeason: league.regularSeasonWeeks,
      ageCurves,
    });

    // The pick chart asks the model's own rookie class what each draft slot is
    // worth; draft slot lives on the crosswalk, not the projection.
    const rookies = players.flatMap((player) => {
      if (player.basis !== 'rookie-prior' || player.draftOverall === undefined) return [];
      const valuation = valued.get(player.playerId);
      return valuation === undefined ? [] : [{ draftOverall: player.draftOverall, dynastyValue: valuation.dynastyValue }];
    });
    const pickChart = edgePickChart(rookies);

    const replacement: Record<string, number> = {};
    for (const valuation of valued.values()) {
      if (!(valuation.position in replacement)) {
        replacement[valuation.position] = valuation.replacementPoints;
      }
    }

    return { players: valued as ReadonlyMap<string, EdgeValuation>, pickChart, replacement };
  })();

  cache.set(key, pending);
  return pending;
};

/** Player prices only, for callers that do not deal in picks. */
export const loadEdgePlayerValues = async (
  league: League,
  season: number,
  asOfWeek: number,
): Promise<ReadonlyMap<string, EdgeValuation>> => (await loadEdgeValues(league, season, asOfWeek)).players;
