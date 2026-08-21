import type { ArtifactPlayer } from './projections';

/**
 * A dynasty roster as a portfolio of correlated assets (§23).
 *
 * The existing roster analysis measures value, age and positional strength, all
 * of which treat players as independent. They are not. Two players from the same
 * offence share a quarterback, a play-caller and a game script; when that
 * offence has a bad Sunday they have it together, and a roster built out of one
 * team is riskier than the same total value spread across six — at identical
 * projected points.
 *
 * That is the one thing a value-weighted roster table cannot show you, and it is
 * the reason finance thinks in covariance rather than in sums.
 *
 * **What is honest here, and what is not.** True player-pair covariance needs a
 * joint distribution estimated from play-by-play, which this repository does not
 * yet have. What it does have is `gameId` — who shares a game — and
 * `gameLoading`, the share of a player's weekly variance explained by the game
 * environment. A one-factor model turns those into a correlation.
 *
 * `gameLoading` is now measured rather than asserted: `export_game_loading.py`
 * correlates each player's weekly surprise against how much his side actually
 * scored, which is exogenous to his target share in a way that earlier attempts
 * — correlating one fantasy score against another — were not.
 *
 * The limit worth naming: one factor represents the *shared environment* and
 * nothing else. A quarterback and his own receiver also have a direct
 * dependency — he throws the passes the receiver catches — which a shootout
 * variable does not capture, so real QB-to-his-own-WR1 correlation sits above
 * what this produces. Fixing that needs a joint distribution, not a bigger
 * constant.
 */

export interface PortfolioPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly mean: number;
  readonly sd: number;
  readonly gameId: string;
  readonly gameLoading: number;
  readonly marketValue: number;
}

export interface Concentration {
  readonly key: string;
  readonly label: string;
  readonly share: number;
  readonly players: readonly string[];
}

export interface PortfolioAnalysis {
  /** Expected weekly points from the starting group. */
  readonly expected: number;
  /** Standard deviation, accounting for shared games. */
  readonly sd: number;
  /** Standard deviation if every player were independent. */
  readonly independentSd: number;
  /**
   * How much correlation widens the roster's weekly range, as a ratio.
   *
   * Above 1 means the roster is more volatile than its parts suggest — the
   * signature of stacking. This is the number the sum-of-values view cannot see.
   */
  readonly correlationPenalty: number;
  /** Share of total value riding on the top two assets. */
  readonly topTwoShare: number;
  readonly byTeam: readonly Concentration[];
  readonly byPosition: readonly Concentration[];
}

/**
 * Correlation between two players, from shared game environment.
 *
 * Same game: the product of their factor loadings, which is the square root of
 * the product of their variance shares. Different games: zero, the right default
 * in a league where nobody plays twice.
 *
 * Same player is 1 by definition and is handled by the caller.
 */
export const correlationOf = (a: PortfolioPlayer, b: PortfolioPlayer): number => {
  if (a.gameId === '' || b.gameId === '') return 0;
  if (a.gameId !== b.gameId) return 0;

  /*
   * `sqrt`, not a product — and the first version of this had it wrong.
   *
   * `gameLoading` is the share of a player's *variance* explained by the game.
   * In a one-factor model `X = sqrt(l)·F + sqrt(1−l)·E`, so the correlation
   * between two players is the product of their factor *loadings* — the square
   * roots — not the product of the variance shares.
   *
   * Multiplying the shares understated every pairing badly: with the measured
   * QB 0.178 and WR 0.031 it gives 0.006, effectively declaring a quarterback
   * and his receiver independent, when the correct figure is 0.074. On the old
   * asserted constants it was 0.18 against a correct 0.42. Either way the
   * portfolio was under-penalising stacked rosters, which is the exact error the
   * feature exists to catch.
   *
   * Opposing players in one game get the same positive term. A shootout lifts
   * both and a defensive struggle sinks both, so the sign is genuinely
   * ambiguous, and assuming opponents are negatively correlated would be a
   * stronger claim than the evidence supports.
   */
  return Math.max(0, Math.min(1, Math.sqrt(a.gameLoading * b.gameLoading)));
};

const concentrations = (
  players: readonly PortfolioPlayer[],
  keyOf: (p: PortfolioPlayer) => string,
  total: number,
): Concentration[] => {
  const groups = new Map<string, { value: number; names: string[] }>();

  for (const player of players) {
    const key = keyOf(player) || '—';
    const group = groups.get(key) ?? { value: 0, names: [] };
    group.value += player.marketValue;
    group.names.push(player.name);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: key,
      share: total > 0 ? group.value / total : 0,
      players: group.names,
    }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share);
};

export const analysePortfolio = (players: readonly PortfolioPlayer[]): PortfolioAnalysis => {
  const expected = players.reduce((sum, p) => sum + p.mean, 0);

  // Independent: variances add. Correlated: the full quadratic form, which is
  // where shared games show up.
  const independentVariance = players.reduce((sum, p) => sum + p.sd * p.sd, 0);

  let variance = 0;
  for (const a of players) {
    for (const b of players) {
      const rho = a.playerId === b.playerId ? 1 : correlationOf(a, b);
      variance += rho * a.sd * b.sd;
    }
  }

  const sd = Math.sqrt(Math.max(0, variance));
  const independentSd = Math.sqrt(Math.max(0, independentVariance));

  const totalValue = players.reduce((sum, p) => sum + p.marketValue, 0);
  const topTwo = [...players]
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, 2)
    .reduce((sum, p) => sum + p.marketValue, 0);

  return {
    expected,
    sd,
    independentSd,
    correlationPenalty: independentSd > 0 ? sd / independentSd : 1,
    topTwoShare: totalValue > 0 ? topTwo / totalValue : 0,
    byTeam: concentrations(players, (p) => p.team, totalValue),
    byPosition: concentrations(players, (p) => p.position, totalValue),
  };
};

/** One sentence on what the portfolio shape means, derived from the numbers. */
export const portfolioRead = (analysis: PortfolioAnalysis): string => {
  const parts: string[] = [];

  if (analysis.correlationPenalty > 1.06) {
    parts.push(
      `Your starters are stacked: shared games widen your weekly range about ${((analysis.correlationPenalty - 1) * 100).toFixed(0)}% beyond what the individual projections imply. That is upside on good Sundays and a floor you cannot rely on.`,
    );
  } else if (analysis.correlationPenalty < 1.02) {
    parts.push(
      'Your starters are spread across games, so their bad weeks arrive separately. That is a narrower range than the raw projections suggest — a contender profile.',
    );
  }

  const topTeam = analysis.byTeam[0];
  if (topTeam !== undefined && topTeam.share > 0.3) {
    parts.push(
      `${(topTeam.share * 100).toFixed(0)}% of your roster value sits in one offence (${topTeam.label}). A coaching change or a quarterback injury there is a roster-level event, not a player-level one.`,
    );
  }

  if (analysis.topTwoShare > 0.4) {
    parts.push(
      `${(analysis.topTwoShare * 100).toFixed(0)}% of your value is in two players — your season is a bet on their health.`,
    );
  }

  return parts.length === 0
    ? 'No concentration worth flagging: value is spread across offences and positions, and your starters do not rise and fall together.'
    : parts.join(' ');
};
