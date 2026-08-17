import type { OddsSnapshot } from './snapshot-store.js';

const API = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds';

/** American odds -> implied probability, still carrying the book's vig. */
const impliedProb = (american: number): number =>
  american > 0 ? 100 / (american + 100) : -american / (-american + 100);

/**
 * Remove the vig.
 *
 * A book's two sides sum to more than 1 — that excess is their margin. The
 * honest probability is each side's share of the total. Skipping this step
 * makes every favourite look stronger than the market actually thinks.
 */
export const devig = (probA: number, probB: number): [number, number] => {
  const overround = probA + probB;
  if (overround <= 0) return [0.5, 0.5];
  return [probA / overround, probB / overround];
};

/**
 * NFL week from kickoff date.
 *
 * The odds feed has no week number, so weeks are derived by bucketing from the
 * season's first kickoff, snapped back to the preceding Tuesday. Deriving beats
 * hardcoding a season-start date that goes stale.
 *
 * The boundary is Tuesday *noon UTC*, not midnight: Monday Night Football
 * kicks at 8:15pm ET, which is already Tuesday in UTC, so a midnight boundary
 * files every MNF game into the following week.
 */
const WEEK_BOUNDARY_HOUR_UTC = 12;

export const weekOf = (commenceAt: Date, seasonFirstKickoff: Date): number => {
  const anchor = new Date(seasonFirstKickoff);
  anchor.setUTCHours(WEEK_BOUNDARY_HOUR_UTC, 0, 0, 0);
  if (anchor > seasonFirstKickoff) anchor.setUTCDate(anchor.getUTCDate() - 1);
  anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() - 2 + 7) % 7));

  const days = (commenceAt.getTime() - anchor.getTime()) / 86_400_000;
  return Math.floor(days / 7) + 1;
};

interface RawOutcome {
  readonly name: string;
  readonly price: number;
  readonly point?: number;
}
interface RawMarket {
  readonly key: string;
  readonly outcomes: readonly RawOutcome[];
}
interface RawGame {
  readonly id: string;
  readonly commence_time: string;
  readonly home_team: string;
  readonly away_team: string;
  readonly bookmakers: readonly { readonly key: string; readonly markets: readonly RawMarket[] }[];
}

export interface OddsFetchResult {
  readonly snapshots: readonly OddsSnapshot[];
  readonly creditsRemaining: number | null;
}

/**
 * Pull current NFL lines. One call covers the whole slate, so this costs a
 * single credit off the 500/month free tier.
 */
export const fetchOdds = async (apiKey: string, season: number): Promise<OddsFetchResult> => {
  const url = `${API}?regions=us&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const games = (await res.json()) as RawGame[];
  const capturedAt = new Date().toISOString();

  const firstKickoff = games.reduce<Date | null>((earliest, g) => {
    const t = new Date(g.commence_time);
    return earliest === null || t < earliest ? t : earliest;
  }, null);
  if (firstKickoff === null) return { snapshots: [], creditsRemaining: null };

  const snapshots: OddsSnapshot[] = [];

  for (const game of games) {
    const commence = new Date(game.commence_time);
    const week = weekOf(commence, firstKickoff);

    for (const book of game.bookmakers) {
      const h2h = book.markets.find((m) => m.key === 'h2h');
      const spreads = book.markets.find((m) => m.key === 'spreads');
      const totals = book.markets.find((m) => m.key === 'totals');

      const homeMl = h2h?.outcomes.find((o) => o.name === game.home_team)?.price;
      const awayMl = h2h?.outcomes.find((o) => o.name === game.away_team)?.price;
      const homeWinProb =
        homeMl === undefined || awayMl === undefined
          ? undefined
          : devig(impliedProb(homeMl), impliedProb(awayMl))[0];

      snapshots.push({
        season,
        week,
        gameId: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceAt: game.commence_time,
        bookmaker: book.key,
        ...(totals?.outcomes[0]?.point !== undefined ? { total: totals.outcomes[0].point } : {}),
        ...(spreads?.outcomes.find((o) => o.name === game.home_team)?.point !== undefined
          ? { homeSpread: spreads.outcomes.find((o) => o.name === game.home_team)!.point }
          : {}),
        ...(homeWinProb !== undefined ? { homeWinProb } : {}),
        capturedAt,
      });
    }
  }

  return { snapshots, creditsRemaining: Number(res.headers.get('x-requests-remaining')) || null };
};

/**
 * Implied points for each team.
 *
 * total = home + away, spread = away - home (a home favourite has a negative
 * spread). Solving gives the market's own scoring forecast — the strongest free
 * prior available for how much fantasy volume a game will generate.
 */
export const impliedTeamPoints = (total: number, homeSpread: number): { home: number; away: number } => ({
  home: total / 2 - homeSpread / 2,
  away: total / 2 + homeSpread / 2,
});
