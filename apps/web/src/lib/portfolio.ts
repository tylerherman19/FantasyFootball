import { readArtifactFile } from './projections';

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
 * **And the factor model is not enough, which is now measured rather than
 * suspected.** One factor can only represent a shared environment. It cannot
 * represent a *direct dependency*, and the most important correlation in fantasy
 * football is exactly that: a quarterback throws the passes his receiver
 * catches. Their fates are linked by the same completions, not merely by the
 * same scoreboard.
 *
 * `model/export_correlation.py` measures within-team co-movement directly, by
 * position pair, and the gap is large:
 *
 *     QB-WR  +0.262 measured   against 0.074 from the factor model
 *     QB-TE  +0.211
 *     WR-WR   0.000            target competition cancels the game effect
 *     RB-RB  -0.022            negative: backs split the same carries
 *     RB-WR  -0.018            negative: a run-heavy script starves receivers
 *
 * Those signs are the finding. Same-position team-mates are *not* positively
 * correlated — they compete — which is why every attempt to measure the game
 * effect by correlating team-mates returned roughly zero. Two effects of
 * opposite sign, cancelling.
 *
 * So team-mates use the measured pair correlation, and players on *opposing*
 * teams in one game keep the factor model, because there is no direct dependency
 * between them — only the shared scoreboard, which is precisely what one factor
 * is for.
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
  readonly value: number;
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
export interface CorrelationTable {
  readonly generatedAt: string;
  /** Position-pair averages: 'QB-WR', 'RB-RB'. */
  readonly pairs: Readonly<Record<string, { readonly correlation: number; readonly pairs: number }>>;
  /**
   * Specific pairs, keyed `playerIdA|playerIdB` with ids sorted.
   *
   * Position-pair resolution says every quarterback-receiver duo co-moves at
   * 0.262, which is plainly false — a quarterback and his primary target are
   * linked far more tightly than the same quarterback and his fifth option.
   * Measured over shared weeks and shrunk toward the position pair by empirical
   * Bayes, true stacks come out near 0.42.
   */
  readonly playerPairs?: Readonly<
    Record<string, { readonly correlation: number; readonly raw: number; readonly shared: number }>
  >;
}

let correlationCache: CorrelationTable | null | undefined;

export const loadCorrelations = async (): Promise<CorrelationTable | null> => {
  if (correlationCache !== undefined) return correlationCache;
  try {
    const raw = await readArtifactFile('correlation.json');
    correlationCache = raw === null ? null : (JSON.parse(raw) as CorrelationTable);
  } catch {
    correlationCache = null;
  }
  return correlationCache;
};

const pairKey = (a: string, b: string): string => [a, b].sort().join('-');

export const correlationOf = (
  a: PortfolioPlayer,
  b: PortfolioPlayer,
  table: CorrelationTable | null = null,
): number => {
  if (a.gameId === '' || b.gameId === '') return 0;
  if (a.gameId !== b.gameId) return 0;

  /*
   * Team-mates: use the measured pair correlation.
   *
   * This is the direct-dependency channel — the same completions, the same
   * carries — and it is the one a single environment factor cannot see. It is
   * also the only place a *negative* correlation is correct, and the measured
   * table has several: two backs on one team split the same carries, so one
   * eating means the other did not.
   */
  if (table !== null && a.team !== '' && a.team === b.team) {
    // Most specific first: this exact pair, if they have shared enough weeks to
    // be estimated. A quarterback and his WR1 measure near 0.42 against a
    // position average of 0.262, and using the average for them would flatten
    // the single most important correlation on a fantasy roster.
    const specific = table.playerPairs?.[[a.playerId, b.playerId].sort().join('|')];
    if (specific !== undefined) return Math.max(-1, Math.min(1, specific.correlation));

    const measured = table.pairs[pairKey(a.position, b.position)];
    if (measured !== undefined) return Math.max(-1, Math.min(1, measured.correlation));
  }

  /*
   * Opposing players in one game: the factor model, which is what it is for.
   *
   * There is no direct dependency across the line of scrimmage — only the
   * shared scoreboard. `gameLoading` is a share of *variance*, so in a
   * one-factor model the correlation is the product of the factor loadings (the
   * square roots), not of the shares. Multiplying the shares understates every
   * pairing and under-penalises stacked rosters, which is the error this whole
   * view exists to catch.
   *
   * The sign is left positive. A shootout lifts both sides and a defensive
   * struggle sinks both; assuming opponents move against each other is a
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
    group.value += player.value;
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

export const analysePortfolio = (
  players: readonly PortfolioPlayer[],
  table: CorrelationTable | null = null,
): PortfolioAnalysis => {
  const expected = players.reduce((sum, p) => sum + p.mean, 0);

  // Independent: variances add. Correlated: the full quadratic form, which is
  // where shared games show up.
  const independentVariance = players.reduce((sum, p) => sum + p.sd * p.sd, 0);

  let variance = 0;
  for (const a of players) {
    for (const b of players) {
      const rho = a.playerId === b.playerId ? 1 : correlationOf(a, b, table);
      variance += rho * a.sd * b.sd;
    }
  }

  const sd = Math.sqrt(Math.max(0, variance));
  const independentSd = Math.sqrt(Math.max(0, independentVariance));

  const totalValue = players.reduce((sum, p) => sum + p.value, 0);
  const topTwo = [...players]
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
    .reduce((sum, p) => sum + p.value, 0);

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
  } else if (analysis.correlationPenalty < 0.98) {
    parts.push(
      'Your starters partly cancel each other: measured co-movement between them is negative, which happens when you hold players who compete for the same touches. That narrows your weekly range — a floor bought by giving up ceiling.',
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
