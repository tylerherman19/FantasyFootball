import { loadIdentities } from './crosswalk';
import { loadHistory, type PlayerHistory } from './history';
import { buildTeamProfiles, type TeamProfile } from './league-analytics';
import type { LeagueView } from './league-data';
import { loadArtifact, scoreFor } from './projections';
import { declineAge, loadAgeCurves, simulateMultiYearValue } from './age-curves';
import { loadEdgePlayerValues } from './edge-values';

/**
 * Win now, or build. The question dynasty actually turns on.
 *
 * Every other page here answers "where do I stand". This one answers "so what
 * do I do about it", and the two are genuinely different: a roster can be third
 * in the league and still be making a mistake by holding, because third with a
 * 29-year-old core is a closing window and third with a 24-year-old core is an
 * opening one.
 *
 * The verdict rests on two axes and nothing else, because everything else is
 * downstream of them:
 *
 *   **Can you win now** — title probability from the simulation, which already
 *   accounts for the roster, the schedule and the rest of the league.
 *   **How long can you win** — value-weighted age, which is the honest measure
 *   of how much of your roster will still be good in three years.
 *
 * Four quadrants, four different correct behaviours. The mistake the market
 * makes constantly is treating "good" and "young" as the same axis; they are
 * not, and the trades that make money are the ones between managers sitting in
 * opposite corners.
 *
 * Nothing here invents a number. Title odds come from the simulation, values
 * from the model's own points-above-replacement pricing (lib/edge-values.ts),
 * ages from birthdates, production from three seasons of real games — this
 * file only puts them on the same table and reads the answer off.
 */

/**
 * Fallback decline ages, used only where the fitted curve cannot answer.
 *
 * These were the whole story until `model/models/age_curves.py` measured the
 * real thing; they now cover the gap where the sample is too thin to fit — in
 * practice quarterbacks, whose paired-season counts run out around 27. Keeping
 * them labelled as assertions rather than deleting them is the point: a number
 * nobody measured should look different from one somebody did.
 */
const DECLINE_AGE: Readonly<Record<string, number>> = {
  QB: 34,
  RB: 27,
  WR: 29,
  TE: 30,
};

/** Where a position's value peaks, for pricing the window rather than the player. */
const PEAK_AGE: Readonly<Record<string, number>> = {
  QB: 28,
  RB: 24,
  WR: 26,
  TE: 27,
};

export type Stance = 'win-now' | 'contend' | 'retool' | 'rebuild';

export interface DynastyAsset {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly age: number | null;
  /** The model's own price: points above replacement, four-season horizon. */
  readonly value: number;
  readonly projected: number;
  readonly history: PlayerHistory | null;
  /** Years until this position typically starts declining. Negative = past it. */
  readonly windowYears: number | null;
  /**
   * Value per point of current production.
   *
   * High means the price is paying for something other than this year — youth,
   * longevity, remaining peak seasons. That is exactly what a contending
   * roster should be selling and a rebuilding one should be buying.
   */
  readonly valuePerPoint: number | null;
  /** Four-season PAR, age-curve walked — the horizon number. */
  readonly dynastyValue: number;
  /** Simulated chance he is still worth at least half of today in year four. */
  readonly fourYearSurvival: number;
}

export interface DynastyVerdict {
  readonly stance: Stance;
  readonly headline: string;
  readonly reasoning: string;
  /** What to do in the next few weeks. */
  readonly shortTerm: readonly string[];
  /** What to do across the next two or three seasons. */
  readonly longTerm: readonly string[];
}

export interface DynastyView {
  /**
   * Decline age per position, and whether it was measured or asserted.
   *
   * Surfaced rather than kept private because the two are not the same claim,
   * and a page that presents them identically is quietly overstating what the
   * model knows.
   */
  readonly declineAges: readonly {
    readonly position: string;
    readonly age: number;
    readonly measured: boolean;
  }[];
  readonly profile: TeamProfile;
  readonly verdict: DynastyVerdict;
  readonly assets: readonly DynastyAsset[];
  /** Roster market value, and how it splits by age band. */
  readonly totalValue: number;
  readonly totalFundamentalValue: number;
  readonly valueByAge: readonly { readonly band: string; readonly value: number; readonly count: number }[];
  readonly valueByPosition: readonly { readonly position: string; readonly value: number; readonly count: number }[];
  /** Old and expensive: what a rebuild sells and a contender pays up for. */
  readonly sellHigh: readonly DynastyAsset[];
  /** Young and cheap relative to production: what to accumulate. */
  readonly buyLow: readonly DynastyAsset[];
  /** Producing now, aging out — the reason a window closes. */
  readonly windowRisk: readonly DynastyAsset[];
  readonly leagueMedianAge: number;
  readonly leagueMedianValue: number;
}

const ageFrom = (birthdate: string | null): number | null => {
  if (birthdate === null) return null;
  const years = (Date.now() - new Date(birthdate).getTime()) / (365.25 * 24 * 3600 * 1000);
  return Number.isFinite(years) && years > 0 && years < 60 ? years : null;
};

/** Stable per-player seed, so a simulated distribution does not change on refresh. */
const hashSeed = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return h || 1;
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * The verdict itself.
 *
 * Thresholds are relative to this league, never absolute. A 12% title chance is
 * strong in a sixteen-team league and mediocre in an eight-team one, and a
 * roster is only old or young compared to the rosters it has to beat.
 */
const decide = (
  profile: TeamProfile,
  medianAge: number,
  teamCount: number,
): DynastyVerdict => {
  // Even odds would give every team 1/teamCount. Better than that is a real
  // claim to contention; well under it is a team hoping rather than competing.
  const evenShare = 1 / Math.max(teamCount, 1);
  const strong = profile.titlePct >= evenShare * 1.15;
  const weak = profile.titlePct < evenShare * 0.7;
  const age = profile.averageAge;

  // Age is read against the league, and a roster within half a year of the
  // median is neither old nor young — but "neither" must not be allowed to
  // decide the stance. Odds are the primary axis: a team that cannot win is
  // rebuilding whatever its age says, and only the *flavour* of the rebuild
  // depends on how young it is. Letting a middling age fall through told a
  // last-place roster it was "in the middle", which is the one read that
  // leads to doing nothing.
  const old = age !== null && age > medianAge + 0.6;

  const odds = `${(profile.titlePct * 100).toFixed(1)}% title odds against an even share of ${(evenShare * 100).toFixed(1)}%`;
  const ageRead =
    age === null
      ? 'no birthdates to age the roster'
      : `${age.toFixed(1)} value-weighted years against a league median of ${medianAge.toFixed(1)}`;

  if (strong && old) {
    return {
      stance: 'win-now',
      headline: 'Win now — the window is open and closing',
      reasoning: `You are one of the teams that can actually win this: ${odds}. But the roster is on the old side — ${ageRead} — so this version of your team is closer to its end than its beginning. Value spent on the future is value spent on a team that will not be this good.`,
      shortTerm: [
        'Trade future picks for immediate starters. A first in two years is worth less to you than two points a week now.',
        'Take the older half of any age-for-age swap; you are buying the seasons you can use.',
        'Spend FAAB aggressively — banked budget converts to nothing in January.',
      ],
      longTerm: [
        'Accept that the bill comes due. Plan to sell the aging core the moment the odds stop justifying it, not a season after.',
        'Keep one or two young pieces unsold so the rebuild has somewhere to start.',
      ],
    };
  }

  if (strong) {
    return {
      stance: 'contend',
      headline: 'Contend — good now and still getting better',
      reasoning: `The rare comfortable position: ${odds}, on a roster that is ${ageRead}. You do not have to choose between this season and the next three, which means you can be patient in trades everyone else has to accept.`,
      shortTerm: [
        'Upgrade at the margins only. Do not pay a contender premium when you are already one.',
        'Fill genuine holes from the wire rather than trading depth you will want later.',
      ],
      longTerm: [
        'Sell into demand from the win-now teams: your surplus is what they are overpaying for.',
        'Hold your picks. You are the team that can afford to let a rookie develop.',
      ],
    };
  }

  if (weak && !old) {
    return {
      stance: 'rebuild',
      headline: 'Rebuild — the future is the only thing worth buying',
      reasoning: `This is not a contending roster: ${odds}. It is a young one — ${ageRead} — which is the good version of being bad, because the assets you already hold will be worth more later than they are now.`,
      shortTerm: [
        'Sell anyone over the position decline age who still has a name. Their value only falls from here.',
        'Ignore the waiver wire for win-now pieces; claim upside and stash it.',
        'Lose cleanly. A better pick is worth more than a meaningless win.',
      ],
      longTerm: [
        'Accumulate first-round picks and second- and third-year breakout candidates.',
        'Buy from the win-now teams at the deadline, when they are least price-sensitive.',
        'Set a target season and stop selling once it is within a year.',
      ],
    };
  }

  if (weak) {
    return {
      stance: 'rebuild',
      headline: 'Rebuild — nothing here is getting better on its own',
      reasoning: `The hardest place to be: ${odds}, on a roster that is ${ageRead}. Holding does not fix either problem — the odds do not improve and the age does — so the only move that changes anything is turning present value into future value while any of it still exists.`,
      shortTerm: [
        'Sell the aging core now, not at the deadline. Every week costs you value.',
        'Take picks and young players over anything that helps this season.',
      ],
      longTerm: [
        'Expect two seasons before this is competitive; plan for that rather than against it.',
        'Prioritise young receivers and quarterbacks — the two positions that hold value longest.',
      ],
    };
  }

  return {
    stance: 'retool',
    headline: 'Retool — in the middle, which is the worst place to stand still',
    reasoning: `${odds}, with the roster ${ageRead}. The middle is the one position with no natural strategy: not good enough that pushing is likely to pay, not bad enough that tearing down is obvious. Standing pat is how a team stays here for three years.`,
    shortTerm: [
      'Pick a direction and commit. Consolidate depth into one genuine starter, or start selling.',
      'Look hard at the positional strength heat map — one upgrade may be all that separates you from the contenders.',
    ],
    longTerm: [
      'Consolidate. Two mid-round assets for one high-end player is the trade that gets a team out of the middle.',
      'Get younger where it is free — take the younger side of any swap the model prices as even.',
    ],
  };
};

export const buildDynastyView = async (
  view: LeagueView,
  teamId: string,
): Promise<DynastyView | null> => {
  const { snapshot } = view;

  const [profiles, artifact, values, identities, history] = await Promise.all([
    buildTeamProfiles(view),
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadEdgePlayerValues(snapshot.league, snapshot.league.season, snapshot.asOfWeek),
    loadIdentities(),
    loadHistory(),
  ]);

  const profile = profiles.find((entry) => entry.teamId === teamId);
  const roster = snapshot.rosters.find((entry) => entry.teamId === teamId);
  if (profile === undefined || roster === undefined) return null;

  const rules = snapshot.league.scoring.raw;

  /*
   * Decline ages read off the fitted curve rather than the table below it.
   * Positions the curve cannot reach keep the asserted value, and the dynasty
   * page says which is which.
   */
  const ageCurves = await loadAgeCurves().catch(() => null);
  const declineAges: Record<string, number> = {};
  const declineSource: Record<string, boolean> = {};
  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    const measured = declineAge(ageCurves, position);
    if (measured !== null) {
      declineAges[position] = measured;
      declineSource[position] = true;
    }
  }
  const declineAgeList = (['QB', 'RB', 'WR', 'TE'] as const).flatMap((position) => {
    const age = declineAges[position] ?? DECLINE_AGE[position];
    return age === undefined
      ? []
      : [{ position, age, measured: declineSource[position] === true }];
  });

  const assets: DynastyAsset[] = roster.playerIds.map((rawId) => {
    const id = String(rawId);
    const projection = artifact?.players[id];
    const identity = identities[id];
    const age = ageFrom(identity?.birthdate ?? null);
    const position = projection?.position ?? identity?.position ?? '?';
    const projected = projection === undefined ? 0 : scoreFor(projection, rules);
    const valuation = values.get(id);
    const value = valuation?.value ?? 0;
    const survival = simulateMultiYearValue(ageCurves, position, age, 4, 2000, hashSeed(id));

    // Measured first, asserted only as a fallback.
    const decline = declineAges[position] ?? DECLINE_AGE[position];
    const windowYears = age === null || decline === undefined ? null : decline - age;

    return {
      playerId: id,
      name: projection?.name ?? identity?.name ?? id,
      position,
      team: projection?.team ?? identity?.team ?? '',
      age,
      value,
      projected,
      history: history.bySleeperId.get(id) ?? null,
      windowYears,
      valuePerPoint: value > 0 && projected > 1 ? value / projected : null,
      dynastyValue: valuation?.dynastyValue ?? 0,
      fourYearSurvival: survival?.survivalOdds ?? 1,
    };
  });

  const valued = assets.filter((asset) => asset.value > 0);
  const totalValue = valued.reduce((sum, asset) => sum + asset.value, 0);
  const totalFundamentalValue = valued.reduce((sum, asset) => sum + asset.dynastyValue, 0);

  const bands: { band: string; min: number; max: number }[] = [
    { band: 'Under 24', min: 0, max: 24 },
    { band: '24–26', min: 24, max: 27 },
    { band: '27–29', min: 27, max: 30 },
    { band: '30+', min: 30, max: 99 },
  ];

  const valueByAge = bands.map(({ band, min, max }) => {
    const inBand = valued.filter((asset) => asset.age !== null && asset.age >= min && asset.age < max);
    return {
      band,
      value: inBand.reduce((sum, asset) => sum + asset.value, 0),
      count: inBand.length,
    };
  });

  const positions = [...new Set(valued.map((asset) => asset.position))];
  const valueByPosition = positions
    .map((position) => {
      const group = valued.filter((asset) => asset.position === position);
      return {
        position,
        value: group.reduce((sum, asset) => sum + asset.value, 0),
        count: group.length,
      };
    })
    .sort((a, b) => b.value - a.value);

  const leagueMedianAge = median(
    profiles.map((entry) => entry.averageAge).filter((age): age is number => age !== null),
  );
  const leagueMedianValue = median(profiles.map((entry) => entry.value));
  const verdict = decide(profile, leagueMedianAge, snapshot.league.teamCount);

  // Old, expensive, and still producing — the profile a contender overpays for
  // and a rebuild should be shipping today.
  const sellHigh = [...valued]
    .filter((asset) => asset.windowYears !== null && asset.windowYears < 1.5 && asset.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  // Cheap relative to what they already do. The market is not paying for this
  // production, which is the definition of a buy.
  const buyLow = [...valued]
    .filter(
      (asset) =>
        asset.valuePerPoint !== null && asset.projected > 4 && (asset.windowYears ?? 0) > 2,
    )
    .sort((a, b) => (a.valuePerPoint ?? 0) - (b.valuePerPoint ?? 0))
    .slice(0, 6);

  // The reason a window closes: real production sitting on players who will not
  // be producing in two years.
  const windowRisk = [...assets]
    .filter((asset) => asset.projected > 6 && (asset.windowYears ?? 9) < 2)
    .sort((a, b) => b.projected - a.projected)
    .slice(0, 6);

  return {
    declineAges: declineAgeList,
    profile,
    verdict,
    assets: assets.sort((a, b) => b.value - a.value),
    totalValue,
    totalFundamentalValue,
    valueByAge,
    valueByPosition,
    sellHigh,
    buyLow,
    windowRisk,
    leagueMedianAge,
    leagueMedianValue,
  };
};

export { DECLINE_AGE, PEAK_AGE };
