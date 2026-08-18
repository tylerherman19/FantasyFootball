/**
 * Score a projected stat line under a league's own rules.
 *
 * The model exports what a player will *do*; this turns that into points for one
 * specific league. Tyler's three leagues use 42, 64 and 132 scoring keys — one
 * with full IDP, one with distance-banded kicking and yardage-allowed tiers — so
 * a single hardcoded ruleset would give two of the three confidently wrong
 * numbers.
 *
 * Mirrors the Python scoring module deliberately: the backtest and the app must
 * agree, or measured accuracy says nothing about what users actually see.
 */

/** Sleeper scoring key -> stat column, one to one. */
const DIRECT: Readonly<Record<string, string>> = {
  pass_yd: 'passing_yards',
  pass_td: 'passing_tds',
  pass_int: 'passing_interceptions',
  pass_cmp: 'completions',
  pass_att: 'attempts',
  pass_fd: 'passing_first_downs',
  pass_sack: 'sacks_suffered',
  rush_yd: 'rushing_yards',
  rush_td: 'rushing_tds',
  rush_att: 'carries',
  rush_fd: 'rushing_first_downs',
  rec: 'receptions',
  rec_yd: 'receiving_yards',
  rec_td: 'receiving_tds',
  rec_fd: 'receiving_first_downs',

  fgm_0_19: 'fg_made_0_19',
  fgm_20_29: 'fg_made_20_29',
  fgm_30_39: 'fg_made_30_39',
  fgm_40_49: 'fg_made_40_49',
  fgm_50_59: 'fg_made_50_59',
  fgm_60p: 'fg_made_60_',
  fgmiss_0_19: 'fg_missed_0_19',
  fgmiss_20_29: 'fg_missed_20_29',
  fgmiss_30_39: 'fg_missed_30_39',
  fgmiss_40_49: 'fg_missed_40_49',
  fgmiss_50_59: 'fg_missed_50_59',
  fgmiss_60p: 'fg_missed_60_',
  fgm: 'fg_made',
  fgmiss: 'fg_missed',
  xpm: 'pat_made',
  xpmiss: 'pat_missed',

  idp_tkl_solo: 'def_tackles_solo',
  idp_tkl_ast: 'def_tackle_assists',
  idp_tkl_loss: 'def_tackles_for_loss',
  idp_sack: 'def_sacks',
  idp_sack_yd: 'def_sack_yards',
  idp_int: 'def_interceptions',
  idp_pass_def: 'def_pass_defended',
  idp_ff: 'def_fumbles_forced',
  idp_fum_rec: 'def_fumbles',
  idp_def_td: 'def_tds',
  idp_safe: 'def_safeties',
  idp_qb_hit: 'def_qb_hits',
  idp_blk_kick: 'def_fg_blocks',

  sack: 'def_sacks',
  int: 'def_interceptions',
  ff: 'def_fumbles_forced',
  fum_rec: 'def_fumbles',
  def_td: 'def_tds',
  safe: 'def_safeties',
  sack_yd: 'def_sack_yards',
  qb_hit: 'def_qb_hits',
  def_pass_def: 'def_pass_defended',
  tkl_solo: 'def_tackles_solo',
  tkl_ast: 'def_tackle_assists',
  tkl_loss: 'def_tackles_for_loss',
  blk_kick: 'def_fg_blocks',
};

/** Keys whose value sums several columns. */
const SUMMED: Readonly<Record<string, readonly string[]>> = {
  fum_lost: ['rushing_fumbles_lost', 'receiving_fumbles_lost', 'sack_fumbles_lost'],
  fum: ['rushing_fumbles', 'receiving_fumbles', 'sack_fumbles'],
  idp_tkl: ['def_tackles_solo', 'def_tackle_assists'],
  tkl: ['def_tackles_solo', 'def_tackle_assists'],
  fgm_50p: ['fg_made_50_59', 'fg_made_60_'],
  fgmiss_50p: ['fg_missed_50_59', 'fg_missed_60_'],
};

/** Bonuses awarded once when a stat clears a threshold. */
const THRESHOLD: Readonly<Record<string, readonly [string, number]>> = {
  bonus_pass_yd_300: ['passing_yards', 300],
  bonus_pass_yd_400: ['passing_yards', 400],
  bonus_pass_cmp_25: ['completions', 25],
  bonus_rush_yd_100: ['rushing_yards', 100],
  bonus_rush_yd_200: ['rushing_yards', 200],
  bonus_rush_att_20: ['carries', 20],
  bonus_rec_yd_100: ['receiving_yards', 100],
  bonus_rec_yd_200: ['receiving_yards', 200],
  bonus_sack_2p: ['def_sacks', 2],
  bonus_tkl_10p: ['def_tackles_solo', 10],
};

/**
 * Points-allowed tiers, for team defenses.
 *
 * Applied against the expected points a defense concedes, which the model
 * carries as `_points_allowed` because it comes from the opponent's scoring
 * rather than the defense's own stat line.
 */
const PTS_ALLOW_TIERS: readonly (readonly [string, number, number])[] = [
  ['pts_allow_0', 0, 0.99],
  ['pts_allow_1_6', 1, 6.99],
  ['pts_allow_7_13', 7, 13.99],
  ['pts_allow_14_20', 14, 20.99],
  ['pts_allow_21_27', 21, 27.99],
  ['pts_allow_28_34', 28, 34.99],
  ['pts_allow_35p', 35, Number.POSITIVE_INFINITY],
];

export type StatLine = Readonly<Record<string, number>>;

/**
 * Threshold bonuses are all-or-nothing on a single game, but a projection is an
 * average. Treating "projected 95 receiving yards" as never earning the
 * 100-yard bonus understates it, and treating 105 as always earning it
 * overstates it. Both are wrong in the same way: the bonus is probabilistic.
 *
 * A logistic ramp around the threshold approximates the probability of clearing
 * it, which is closer to right than either hard answer.
 */
const thresholdProbability = (projected: number, threshold: number): number => {
  if (threshold <= 0) return projected > 0 ? 1 : 0;
  // Spread scales with the threshold: 100-yard games vary more than 2-sack ones.
  const spread = Math.max(1, threshold * 0.35);
  return 1 / (1 + Math.exp(-(projected - threshold) / spread));
};

export const scoreStatLine = (stats: StatLine, rules: Readonly<Record<string, number>>): number => {
  let points = 0;

  for (const [key, weight] of Object.entries(rules)) {
    if (weight === 0) continue;

    const direct = DIRECT[key];
    if (direct !== undefined) {
      points += (stats[direct] ?? 0) * weight;
      continue;
    }

    const summed = SUMMED[key];
    if (summed !== undefined) {
      for (const column of summed) points += (stats[column] ?? 0) * weight;
      continue;
    }

    const threshold = THRESHOLD[key];
    if (threshold !== undefined) {
      const [column, limit] = threshold;
      points += thresholdProbability(stats[column] ?? 0, limit) * weight;
      continue;
    }
  }

  // Team-defense points-allowed tier, if the league scores one and the line
  // carries an expectation.
  const allowed = stats['_points_allowed'];
  if (allowed !== undefined) {
    for (const [key, low, high] of PTS_ALLOW_TIERS) {
      const weight = rules[key];
      if (weight === undefined || weight === 0) continue;
      if (allowed >= low && allowed <= high) {
        points += weight;
        break;
      }
    }
  }

  return points;
};

/** Which of a league's scoring keys this engine can evaluate. */
export const scoringCoverage = (
  rules: Readonly<Record<string, number>>,
): { applied: string[]; unsupported: string[] } => {
  const applied: string[] = [];
  const unsupported: string[] = [];

  for (const [key, weight] of Object.entries(rules)) {
    if (weight === 0) continue;
    const known =
      DIRECT[key] !== undefined ||
      SUMMED[key] !== undefined ||
      THRESHOLD[key] !== undefined ||
      key.startsWith('pts_allow_');
    (known ? applied : unsupported).push(key);
  }

  return { applied, unsupported };
};
