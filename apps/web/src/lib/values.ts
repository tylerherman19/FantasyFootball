import {
  scoreStatLine,
  valueAssets,
  type AssetValue,
  type LeagueSnapshot,
  type Position,
  type ValuationInput,
} from '@ffe/core';
import { loadAgeCurves, yearByYearOutlook, type AgeCurves } from './age-curves';
import { ttlCache } from './cache';
import { loadIdentities } from './crosswalk';
import { loadArtifact } from './projections';

/**
 * Asset values, computed here.
 *
 * This module used to be a `fetch` to `api.fantasycalc.com`. Everything the
 * product says about a trade, a sell candidate, a roster's worth or a draft
 * pick was priced by that request, which made a third party the author of the
 * site's central number. Three problems, in ascending order of seriousness.
 *
 * It was a network call on the render path of six pages. It was a single point
 * of failure whose outage degraded the product silently — the old code returned
 * empty maps on a non-OK response, so a trade page would render with every
 * asset worth zero and no explanation.
 *
 * And it could not describe the league it was pricing. The endpoint takes four
 * parameters — dynasty, quarterback count, team count, PPR — and that is the
 * entire extent of its knowledge. It does not know this league starts a third
 * receiver, plays two flexes, gives a point per first down, or that eleven
 * weeks remain. Those are the facts that decide value, and they were being
 * dropped on the floor.
 *
 * So values now come from the model that is already running: project every
 * player under *this* league's scoring, work out what actually starts in *this*
 * league's lineup, and price the gap. `@ffe/core`'s `valueAssets` does the
 * arithmetic and can be tested; this file supplies it the league.
 *
 * The published shape is unchanged, so every consumer reads the same fields as
 * before. What changed is that the number is now ours, is explainable down to
 * a replacement level we can show, and costs no network call at all.
 */

export interface MarketValue {
  readonly sleeperId: string;
  readonly name: string;
  readonly position: string;
  readonly value: number;
  readonly overallRank: number;
  /**
   * Share of rosters carrying the player.
   *
   * Always null now. It was the one field the purchased feed supplied that the
   * model cannot derive — it is a fact about other people's leagues, not about
   * football — and inventing a proxy for it would be worse than admitting we no
   * longer have it. Consumers already treat null as "unknown".
   */
  readonly rosteredPct: number | null;
  /** Points per game above this league's replacement level at his position. */
  readonly pointsAboveReplacement: number;
  /** The replacement level he was priced against, per game. */
  readonly replacementLevel: number;
  /** Share of his value that comes from seasons after this one. */
  readonly futureShare: number;
}

export interface MarketData {
  readonly players: Map<string, MarketValue>;
  /** Draft picks, keyed by their label ("2027 1st (Early)"). */
  readonly picks: Map<string, number>;
  /** The incoming rookie class in index units, best first. Prices the picks. */
  readonly rookieValues: readonly number[];
  /** Replacement level per position, per game — the model's own working. */
  readonly replacement: ReadonlyMap<string, number>;
}

const SKILL: readonly Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

const isPosition = (value: string): value is Position =>
  (SKILL as readonly string[]).includes(value);

/** How many seasons beyond this one a dynasty valuation looks. */
const HORIZON_YEARS = 4;

/**
 * Points per game, healthy.
 *
 * Availability is deliberately *not* applied. A questionable tag is a fact
 * about Sunday and a trade is a decision about the rest of the season, so
 * discounting an asset's price for a one-week designation would make the sell
 * recommendations lurch every Friday. The lineup pages apply availability;
 * valuation should not.
 */
const perGamePoints = (
  stats: Readonly<Record<string, number>> | undefined,
  rules: Readonly<Record<string, number>>,
): number => Math.max(0, scoreStatLine(stats ?? {}, rules));

const ageOn = (birthdate: string | null | undefined, season: number): number | null => {
  if (!birthdate) return null;
  const born = new Date(birthdate);
  if (Number.isNaN(born.getTime())) return null;
  // Measured to the season opener rather than to today, so a player's value
  // does not step on his birthday mid-week.
  const opener = new Date(Date.UTC(season, 8, 5));
  const years = (opener.getTime() - born.getTime()) / (365.25 * 24 * 3600 * 1000);
  return years > 15 && years < 50 ? years : null;
};

/**
 * How much of this player's current level each future season is worth.
 *
 * From the fitted curves where they reach him. Where they do not — a
 * quarterback past 27, whose curve stops there — the result is short or empty
 * and `valueAssets` prices only the seasons it actually knows about, which is
 * the honest treatment of a curve that has run out of data.
 */
const futureSeasons = (
  curves: AgeCurves | null,
  position: Position,
  age: number | null,
): readonly number[] => {
  const outlook = yearByYearOutlook(curves, position, age, HORIZON_YEARS);
  const known: number[] = [];
  for (const year of outlook) {
    if (year === null) break;
    known.push(year);
  }
  return known;
};

const buildMarket = async (
  snapshot: LeagueSnapshot,
  weeksRemaining: number,
): Promise<MarketData> => {
  const [artifact, identities, curves] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadIdentities(),
    loadAgeCurves(),
  ]);

  if (artifact === null) {
    return { players: new Map(), picks: new Map(), rookieValues: [], replacement: new Map() };
  }

  const rules = snapshot.league.scoring.raw;
  const multiYear = snapshot.league.format === 'dynasty' || snapshot.league.format === 'keeper';
  const season = snapshot.league.season;

  const inputs: ValuationInput[] = [];
  const rookieIds = new Set<string>();

  for (const player of Object.values(artifact.players)) {
    if (!player.active) continue;
    if (!isPosition(player.position)) continue;

    const identity = identities[player.playerId];
    const age = ageOn(identity?.birthdate, season);

    // A rookie is one drafted into this season's class, by draft year rather
    // than by whether we happen to hold history for him — a UDFA with no
    // projection is still a rookie and still lands in the rookie draft.
    if (identity?.draftYear === season) rookieIds.add(player.playerId);

    inputs.push({
      playerId: player.playerId,
      name: player.name,
      position: player.position,
      pointsPerGame: perGamePoints(player.stats, rules),
      futureSeasons: multiYear ? futureSeasons(curves, player.position, age) : undefined,
      rookie: player.basis === 'rookie-prior',
    });
  }

  const assets = valueAssets(inputs, {
    teamCount: snapshot.league.teamCount,
    rosterSlots: snapshot.league.rosterSlots,
    gamesRemaining: Math.max(1, weeksRemaining),
    multiYear,
  });

  const players = new Map<string, MarketValue>();
  for (const asset of assets) {
    players.set(asset.playerId, toMarketValue(asset));
  }

  const rookieValues = assets
    .filter((asset) => rookieIds.has(asset.playerId))
    .map((asset) => asset.value)
    .sort((a, b) => b - a);

  const replacement = new Map<string, number>();
  for (const asset of assets) {
    if (!replacement.has(asset.position)) replacement.set(asset.position, asset.replacementLevel);
  }

  // Pick *labels* are produced by `pick-data.ts`, which knows the league's
  // seasons and rounds. This exposes the class those labels get priced from
  // rather than a second, drifting copy of the pricing.
  return { players, picks: new Map(), rookieValues, replacement };
};

const toMarketValue = (asset: AssetValue): MarketValue => ({
  sleeperId: asset.playerId,
  name: asset.name,
  position: asset.position,
  value: asset.value,
  overallRank: asset.overallRank,
  rosteredPct: null,
  pointsAboveReplacement: asset.pointsAboveReplacement,
  replacementLevel: asset.replacementLevel,
  futureShare: asset.futureShare,
});

/**
 * Weeks left in the regular season, floored at one.
 *
 * A redraft asset in week 15 is worth two games, not seventeen, and a valuation
 * that ignores that recommends the same sells in December as in September.
 */
const weeksRemainingIn = (snapshot: LeagueSnapshot): number =>
  Math.max(1, snapshot.league.regularSeasonWeeks - snapshot.asOfWeek + 1);

/**
 * Cached per league and week.
 *
 * The computation is a few milliseconds over a couple of thousand players and
 * it no longer touches the network, but six routes ask for it on every
 * navigation and there is no reason for any of them to repeat it.
 */
const cachedMarket = ttlCache(
  60 * 60 * 1000,
  (snapshot: LeagueSnapshot, weeks: number) =>
    `${snapshot.league.id}:${snapshot.league.season}:${snapshot.asOfWeek}:${weeks}`,
  buildMarket,
  { name: 'market-values', maxEntries: 32 },
);

export const loadMarketData = async (snapshot: LeagueSnapshot): Promise<MarketData> =>
  cachedMarket(snapshot, weeksRemainingIn(snapshot));

/** Player values only, for callers that don't deal in picks. */
export const loadMarketValues = async (
  snapshot: LeagueSnapshot,
): Promise<Map<string, MarketValue>> => (await loadMarketData(snapshot)).players;
