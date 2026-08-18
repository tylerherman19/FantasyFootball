import { asPlayerId, findTrades, type Position, type TradeAsset, type TradeEvaluation } from '@ffe/core';
import type { LeagueView } from './league-data';
import { loadArtifact } from './projections';
import { loadMarketValues } from './values';

/**
 * Trade suggestions for one team.
 *
 * Combines the two halves the plan calls for: market value decides whether a
 * proposal is plausible, simulation decides whether it is good for you. Neither
 * alone is enough — value-only tools call a trade "even" when it does nothing
 * for your season, odds-only tools propose fleeces nobody would accept.
 */

const SCREEN_ITERATIONS = 400;
const FINALIST_ITERATIONS = 4_000;

/**
 * Positions worth trading.
 *
 * Kickers and team defenses are streamed off the wire every week, so a model
 * that notices you are "short a kicker" and proposes a trade for one is
 * technically correct and practically useless. They are excluded rather than
 * ranked low, because the right number of trade offers for a kicker is zero.
 */
const TRADEABLE: readonly Position[] = ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB'];

export interface TradeView {
  readonly evaluations: readonly TradeEvaluation[];
  readonly needs: readonly Position[];
  readonly surplus: readonly Position[];
  readonly valuesAvailable: boolean;
}

/**
 * Infer what a roster is short of and long on.
 *
 * Compares each position's starter-quality depth against what the league's
 * lineup actually demands, so "I need a receiver" is measured against this
 * league's slots rather than a generic template.
 */
const inferNeeds = (
  positionCounts: Map<Position, number>,
  required: Map<Position, number>,
): { needs: Position[]; surplus: Position[] } => {
  const needs: Position[] = [];
  const surplus: Position[] = [];

  for (const [position, demand] of required) {
    if (!TRADEABLE.includes(position)) continue;
    const have = positionCounts.get(position) ?? 0;
    // One spare body per starting slot is healthy; beyond that is tradeable.
    if (have < demand + 1) needs.push(position);
    else if (have > demand + 2) surplus.push(position);
  }

  return { needs, surplus };
};

export const loadTrades = async (view: LeagueView, teamId: string): Promise<TradeView | null> => {
  const { snapshot, context } = view;

  const artifact = await loadArtifact(snapshot.league.season, snapshot.asOfWeek);
  if (artifact === null) return null;

  const values = await loadMarketValues(snapshot.league.format, snapshot.league.superFlex);

  const assetFor = (playerId: string): TradeAsset | null => {
    const projection = artifact.players[playerId];
    const market = values.get(playerId);
    if (projection === undefined || market === undefined) return null;

    return {
      playerId: asPlayerId(playerId),
      name: projection.name || market.name,
      position: projection.position as Position,
      value: market.value,
    };
  };

  const assetsByTeam = new Map<string, TradeAsset[]>();
  for (const roster of snapshot.rosters) {
    const assets = roster.playerIds
      .map((id) => assetFor(String(id)))
      .filter((asset): asset is TradeAsset => asset !== null);
    assetsByTeam.set(roster.teamId, assets);
  }

  // What this league's lineup demands, position by position.
  const required = new Map<Position, number>();
  for (const slot of snapshot.league.rosterSlots) {
    if (slot === 'BN' || slot === 'IR' || slot === 'TAXI') continue;
    const base = slot === 'FLEX' || slot === 'SUPER_FLEX' || slot === 'WRRB_FLEX' || slot === 'REC_FLEX'
      ? null
      : (slot as Position);
    if (base !== null) required.set(base, (required.get(base) ?? 0) + 1);
  }

  const mine = assetsByTeam.get(teamId) ?? [];
  const counts = new Map<Position, number>();
  for (const asset of mine) counts.set(asset.position, (counts.get(asset.position) ?? 0) + 1);

  const { needs, surplus } = inferNeeds(counts, required);

  if (needs.length === 0 || surplus.length === 0 || values.size === 0) {
    return { evaluations: [], needs, surplus, valuesAvailable: values.size > 0 };
  }

  // Screen cheaply, then re-simulate the survivors precisely — the same
  // two-stage shape the waiver page uses.
  const screened = findTrades({
    context: { ...context, iterations: SCREEN_ITERATIONS },
    myTeamId: teamId,
    assetsByTeam,
    needs,
    surplus,
    finalists: 12,
  });

  const evaluations = screened
    .slice(0, 5)
    .map((candidate) =>
      findTrades({
        context: { ...context, iterations: FINALIST_ITERATIONS },
        myTeamId: teamId,
        assetsByTeam: new Map([
          [teamId, candidate.sideA.sends],
          [candidate.sideB.teamId, candidate.sideB.sends],
        ]),
        needs,
        surplus,
        finalists: 1,
      }),
    )
    .flat();

  return { evaluations, needs, surplus, valuesAvailable: true };
};
